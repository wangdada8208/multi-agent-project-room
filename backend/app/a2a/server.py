"""A2A Protocol v1.0 server — official a2a-sdk integration.

Replaces the hand-written JSON-RPC implementation with the official SDK.
The RoomAgentExecutor bridges A2A protocol requests to our room/chat system.

Protocol routes:
  GET  /.well-known/agent-card.json   — Agent Card discovery
  POST /a2a/rpc                       — JSON-RPC unified endpoint
"""

from __future__ import annotations

import uuid
import logging
from datetime import datetime, timedelta, timezone

import pydantic
from fastapi import APIRouter, Depends, HTTPException, Request
from app.core.security import get_current_user
from app.models.user import User

from a2a.server.agent_execution.agent_executor import AgentExecutor
from a2a.server.agent_execution.context import RequestContext
from a2a.server.events.event_queue import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks.inmemory_task_store import InMemoryTaskStore
from a2a.server.routes.agent_card_routes import create_agent_card_routes
from a2a.server.routes.jsonrpc_routes import create_jsonrpc_routes
from a2a.types import (
    AgentCard,
    Message,
    Part,
    Task,
    TaskState,
    TaskStatus,
)

from app.config import get_settings
from app.a2a.agent_card import build_hub_card, card_to_dict
from app.a2a import task_manager as tm
from app.a2a.discovery import AgentDiscovery
from app.chat import service as chat_service
from app.core.database import async_session
from app.ws.connection_manager import connection_manager

logger = logging.getLogger(__name__)
settings = get_settings()

# ── Legacy dialogue RPC methods ────────────────────────

router = APIRouter(prefix="/a2a", tags=["a2a-dialogue"])

DIALOGUES: dict[str, dict] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _serialize_dialogue(dialogue: dict) -> dict:
    data = dialogue.copy()
    for key in ("created_at", "expires_at", "ended_at"):
        value = data.get(key)
        if isinstance(value, datetime):
            data[key] = value.isoformat()
    return data


def _normalize_participants(participants: list[str], initiator: str) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    for name in [initiator, *participants]:
        clean = str(name).strip()
        if not clean or clean.lower() in seen:
            continue
        seen.add(clean.lower())
        normalized.append(clean)
    return normalized


def _dialogue_peer(dialogue: dict, sender_name: str, target_agent: str | None) -> str:
    if target_agent:
        return target_agent
    for participant in dialogue["participants"]:
        if participant.lower() != sender_name.lower():
            return participant
    raise ValueError("target_agent is required for single-participant dialogues")


async def _save_room_message(
    room_id: str,
    sender_id: str,
    sender_name: str,
    content: str,
    dialogue_id: str,
) -> dict:
    try:
        async with async_session() as db:
            await chat_service.get_or_create_room(
                db, room_id, name=f"Room {room_id[:8]}"
            )
            message = await chat_service.save_message(
                db=db,
                room_id=room_id,
                sender_id=sender_id,
                sender_type="agent",
                sender_name=sender_name,
                content=content,
                msg_type="text",
                parent_id=dialogue_id,
            )
            return message.to_dict()
    except Exception as e:
        logger.warning("dialogue message persistence failed: %s", e)
        return {
            "id": str(uuid.uuid4()),
            "room_id": room_id,
            "sender_id": sender_id,
            "sender_type": "agent",
            "sender_name": sender_name,
            "content": content,
            "msg_type": "text",
            "parent_id": dialogue_id,
            "created_at": _now().isoformat(),
            "persistence": "failed",
        }


class DialogueRequest(pydantic.BaseModel):
    jsonrpc: str = "2.0"
    method: str
    params: dict = {}
    id: str | int | None = None


DIALOGUE_METHODS: dict[str, callable] = {}


def rpc_method(name: str):
    def wrapper(fn):
        DIALOGUE_METHODS[name] = fn
        return fn
    return wrapper


@router.post("/dialogue-rpc")
async def handle_dialogue_jsonrpc(request: DialogueRequest, current_user: User = Depends(get_current_user)):
    """Dialogue-specific and agent-discovery JSON-RPC methods."""
    handler = DIALOGUE_METHODS.get(request.method)
    if not handler:
        raise HTTPException(status_code=404, detail=f"Method not found: {request.method}")
    try:
        import inspect
        sig = inspect.signature(handler)
        if "user" in sig.parameters:
            result = await handler(request.params, user=current_user)
        else:
            result = await handler(request.params)
        return {"jsonrpc": "2.0", "result": result, "id": request.id}
    except HTTPException:
        raise
    except Exception as e:
        return {"jsonrpc": "2.0", "error": {"code": -32000, "message": str(e)}, "id": request.id}


@rpc_method("dialogues/create")
async def rpc_dialogues_create(params: dict, user: User) -> dict:
    room_id = str(params.get("room_id", "")).strip()
    if not room_id:
        raise HTTPException(status_code=400, detail="room_id is required")

    from app.models.room import Room
    from app.models.room_permission import RoomPermission
    from sqlalchemy import select

    async with async_session() as db:
        room = await db.get(Room, room_id)
        if not room:
            room = Room(id=room_id, name=f"Room {room_id[:8]}", created_by=user.id)
            db.add(room)
            await db.flush()
            perm = RoomPermission(room_id=room_id, user_id=user.id, role="owner")
            db.add(perm)
            await db.commit()
        else:
            perm_stmt = select(RoomPermission).where(
                RoomPermission.room_id == room_id,
                RoomPermission.user_id == user.id,
            )
            perm = (await db.execute(perm_stmt)).scalars().first()
            if not perm:
                any_perm_stmt = select(RoomPermission).where(RoomPermission.room_id == room_id)
                any_perms = (await db.execute(any_perm_stmt)).scalars().all()
                if not any_perms:
                    perm = RoomPermission(room_id=room_id, user_id=user.id, role="owner")
                    db.add(perm)
                    await db.commit()
                else:
                    raise HTTPException(status_code=403, detail="No access to this room")
            elif perm.role not in ("owner", "member"):
                raise HTTPException(status_code=403, detail="Requires member or owner role")

    initiator = str(params.get("initiator_agent", "")).strip() or "hub"
    participants = [str(p) for p in params.get("participants", [])]
    duration_seconds = int(params.get("duration_seconds") or 30)
    max_turns = int(params.get("max_turns") or 8)
    duration_seconds = max(5, min(duration_seconds, 300))
    max_turns = max(1, min(max_turns, 40))
    now = _now()
    dialogue_id = str(params.get("dialogue_id") or uuid.uuid4())
    dialogue = {
        "dialogue_id": dialogue_id,
        "room_id": room_id,
        "created_by_user_id": user.id,
        "initiator_agent": initiator,
        "participants": _normalize_participants(participants, initiator),
        "status": "active",
        "current_turn": 0,
        "max_turns": max_turns,
        "created_at": now,
        "expires_at": now + timedelta(seconds=duration_seconds),
        "ended_at": None,
        "reason": None,
    }
    if len(dialogue["participants"]) < 2:
        raise HTTPException(status_code=400, detail="dialogue requires at least two participants")
    DIALOGUES[dialogue_id] = dialogue
    return _serialize_dialogue(dialogue)


@rpc_method("dialogues/send")
async def rpc_dialogues_send(params: dict, user: User) -> dict:
    dialogue_id = str(params.get("dialogue_id", "")).strip()
    content = str(params.get("content", "")).strip()
    sender_id = str(params.get("sender_id", "")).strip()
    sender_name = str(params.get("sender_name", "")).strip()
    if not dialogue_id or not content or not sender_id or not sender_name:
        raise HTTPException(status_code=400, detail="dialogue_id, content, sender_id, and sender_name are required")

    dialogue = DIALOGUES.get(dialogue_id)
    if not dialogue:
        raise ValueError("Dialogue is not active")

    from app.models.room_permission import RoomPermission
    from app.models.user import User as UserModel
    from sqlalchemy import select

    async with async_session() as db:
        perm_stmt = select(RoomPermission).where(
            RoomPermission.room_id == dialogue["room_id"],
            RoomPermission.user_id == user.id,
        )
        perm = (await db.execute(perm_stmt)).scalars().first()
        if not perm:
            any_perm_stmt = select(RoomPermission).where(RoomPermission.room_id == dialogue["room_id"])
            any_perms = (await db.execute(any_perm_stmt)).scalars().all()
            if any_perms:
                raise HTTPException(status_code=403, detail="No access to this room")
            perm = RoomPermission(room_id=dialogue["room_id"], user_id=user.id, role="owner")
            db.add(perm)
            await db.commit()
        elif perm.role not in ("owner", "member"):
            raise HTTPException(status_code=403, detail="Requires member or owner role")

        # Impersonation guard: cannot forge another real user ID as sender_id
        if sender_id != user.id:
            other_user = await db.get(UserModel, sender_id)
            if other_user and other_user.id != user.id:
                raise HTTPException(status_code=403, detail="Impersonation of another user is prohibited")
    if not dialogue or dialogue["status"] != "active":
        raise ValueError("Dialogue is not active")
    if _now() >= dialogue["expires_at"]:
        dialogue["status"] = "ended"
        dialogue["ended_at"] = _now()
        dialogue["reason"] = "expired"
        raise ValueError("Dialogue is not active")
    if dialogue["current_turn"] >= dialogue["max_turns"]:
        dialogue["status"] = "ended"
        dialogue["ended_at"] = _now()
        dialogue["reason"] = "max_turns_reached"
        raise ValueError("Dialogue is not active")
    if sender_name.lower() not in {p.lower() for p in dialogue["participants"]}:
        raise ValueError("Sender is not a dialogue participant")

    target_agent = _dialogue_peer(dialogue, sender_name, params.get("target_agent"))
    if target_agent.lower() not in {p.lower() for p in dialogue["participants"]}:
        raise ValueError("target_agent is not a dialogue participant")

    dialogue["current_turn"] += 1
    if dialogue["current_turn"] >= dialogue["max_turns"]:
        dialogue["status"] = "ending"

    message_payload = await _save_room_message(
        room_id=dialogue["room_id"],
        sender_id=sender_id,
        sender_name=sender_name,
        content=content,
        dialogue_id=dialogue_id,
    )
    message_payload["dialogue_id"] = dialogue_id
    message_payload["target_agent"] = target_agent

    await connection_manager.broadcast(
        dialogue["room_id"],
        {"type": "message", "message": message_payload},
    )
    await connection_manager.broadcast(
        dialogue["room_id"],
        {
            "type": "agent_dialogue_message",
            "dialogue": _serialize_dialogue(dialogue),
            "message": message_payload,
        },
    )
    return {
        "status": "sent",
        "dialogue_id": dialogue_id,
        "message_id": message_payload["id"],
        "target_agent": target_agent,
        "current_turn": dialogue["current_turn"],
        "dialogue_status": dialogue["status"],
    }


@rpc_method("dialogues/end")
async def rpc_dialogues_end(params: dict, user: User) -> dict:
    dialogue_id = str(params.get("dialogue_id", "")).strip()
    if not dialogue_id:
        raise HTTPException(status_code=400, detail="dialogue_id is required")
    dialogue = DIALOGUES.get(dialogue_id)
    if not dialogue:
        raise ValueError("Dialogue not found")

    from app.models.room_permission import RoomPermission
    from sqlalchemy import select

    async with async_session() as db:
        perm_stmt = select(RoomPermission).where(
            RoomPermission.room_id == dialogue["room_id"],
            RoomPermission.user_id == user.id,
        )
        perm = (await db.execute(perm_stmt)).scalars().first()
        if perm and perm.role not in ("owner", "member"):
            raise HTTPException(status_code=403, detail="Insufficient permission to end dialogue")
    dialogue["status"] = "ended"
    dialogue["ended_at"] = _now()
    dialogue["reason"] = params.get("reason") or "ended"
    await connection_manager.broadcast(
        dialogue["room_id"],
        {"type": "agent_dialogue_ended", "dialogue": _serialize_dialogue(dialogue)},
    )
    # Cleanup: remove ended dialogue after 60 seconds to prevent memory leak
    import asyncio
    async def _delayed_cleanup(did=dialogue_id):
        await asyncio.sleep(60)
        DIALOGUES.pop(did, None)
        RUNNING_LOOPS.discard(did)
    asyncio.create_task(_delayed_cleanup())
    return _serialize_dialogue(dialogue)



# ── Dialogue auto-run: backend drives agent-to-agent message loop ──

RUNNING_LOOPS: set[str] = set()


async def _send_to_agent(agent_name: str, prompt: str) -> str:
    """Send a prompt to a registered agent via its A2A task endpoint.

    Falls back to simulated response if the agent is unreachable.
    """
    agents = await AgentDiscovery.list_available()
    target = next(
        (a for a in agents if a["name"].lower() == agent_name.lower()), None
    )
    if not target or not target.get("url") or target["url"].startswith("local://"):
        # Simulated fallback
        return f"[{agent_name}] 收到。我同意当前方案，建议继续推进。"

    try:
        import httpx
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{target['url'].rstrip('/')}/a2a/rpc",
                json={
                    "jsonrpc": "2.0",
                    "method": "tasks/send",
                    "params": {"query": prompt},
                    "id": str(uuid.uuid4()),
                },
            )
            data = resp.json()
            result = data.get("result", {})
            artifacts = result.get("artifacts", [])
            if artifacts and isinstance(artifacts, list):
                first = artifacts[0]
                if isinstance(first, dict):
                    parts = first.get("parts", [])
                    if parts:
                        return str(parts[0])
            return f"[{agent_name}] 已处理任务（无文本返回）"
    except Exception as e:
        logger.warning("Failed to reach agent %s: %s", agent_name, e)
        return f"[{agent_name}] 无法连接，使用默认回复：同意继续。"


async def _run_dialogue_loop(dialogue_id: str):
    """Background task that drives the dialogue loop until consensus or max turns."""
    import asyncio

    dialogue = DIALOGUES.get(dialogue_id)
    if not dialogue or dialogue_id in RUNNING_LOOPS:
        return

    RUNNING_LOOPS.add(dialogue_id)
    participants = dialogue["participants"]
    room_id = dialogue["room_id"]

    try:
        topic = dialogue.get("topic", "请讨论并达成共识")

        for round_num in range(dialogue["max_turns"]):
            if dialogue["status"] != "active":
                break

            for i, agent_name in enumerate(participants):
                if dialogue["status"] != "active":
                    break

                # Build context (reset each turn to prevent pollution)
                recent = [
                    t["content"][:200]
                    for t in dialogue.get("turns", [])[-2:]
                ]
                context = (
                    f"## 协作主题\n{topic}\n\n"
                    f"## 当前进度\n第 {round_num + 1} 轮\n"
                )
                if recent:
                    context += "## 最近讨论\n" + "\n".join(recent)
                context += (
                    "\n\n请回复你的观点。如果已达成共识，回复开头加 [CONSENSUS]。"
                )

                # Send to agent and get response
                response_text = await _send_to_agent(agent_name, context)

                # Record turn
                if "turns" not in dialogue:
                    dialogue["turns"] = []
                turn_data = {
                    "agent": agent_name,
                    "content": response_text,
                    "round": round_num + 1,
                    "consensus": "[CONSENSUS]" in response_text.upper(),
                    "conflicts": [],
                }
                dialogue["turns"].append(turn_data)

                # Save to room as chat message
                await _save_room_message(
                    room_id=room_id,
                    sender_id=f"{agent_name.lower()}-loop",
                    sender_name=agent_name,
                    content=response_text,
                    dialogue_id=dialogue_id,
                )

                # Broadcast to WebSocket
                await connection_manager.broadcast(room_id, {
                    "type": "message",
                    "message": {
                        "id": str(uuid.uuid4()),
                        "room_id": room_id,
                        "sender_id": f"{agent_name.lower()}-loop",
                        "sender_type": "agent",
                        "sender_name": agent_name,
                        "content": response_text,
                        "msg_type": "text",
                        "parent_id": dialogue_id,
                        "created_at": _now().isoformat(),
                    },
                })

                # Check consensus
                if turn_data["consensus"]:
                    dialogue["status"] = "ended"
                    dialogue["reason"] = "consensus"
                    dialogue["ended_at"] = _now()
                    break

            else:
                continue  # Next round
            break  # Consensus reached or ended

        if dialogue["status"] == "active":
            dialogue["status"] = "ended"
            dialogue["reason"] = "max_turns_reached"
            dialogue["ended_at"] = _now()

    finally:
        RUNNING_LOOPS.discard(dialogue_id)
        await connection_manager.broadcast(room_id, {
            "type": "agent_dialogue_ended",
            "dialogue": _serialize_dialogue(dialogue),
        })


@rpc_method("dialogues/run")
async def rpc_dialogues_run(params: dict) -> dict:
    """Start an auto-running dialogue loop between two or more agents."""
    room_id = str(params.get("room_id", "")).strip()
    initiator = str(params.get("initiator_agent", "")).strip() or "hub"
    participants = [str(p).strip() for p in params.get("participants", [])]
    topic = str(params.get("topic", "")).strip() or "请讨论以下话题并达成共识"
    max_turns = max(2, min(int(params.get("max_turns") or 6), 20))

    if not room_id:
        raise HTTPException(status_code=400, detail="room_id is required")
    if len(participants) < 1:
        raise HTTPException(status_code=400, detail="at least 1 participant required")
    if len(RUNNING_LOOPS) >= 5:
        raise HTTPException(status_code=429, detail="Too many concurrent dialogue loops (max 5)")

    now = _now()
    dialogue_id = str(uuid.uuid4())
    all_participants = list({initiator, *participants})

    dialogue = {
        "dialogue_id": dialogue_id,
        "room_id": room_id,
        "initiator_agent": initiator,
        "participants": all_participants,
        "topic": topic,
        "status": "active",
        "current_turn": 0,
        "max_turns": max_turns,
        "turns": [],
        "created_at": now,
        "expires_at": now + timedelta(seconds=300),
        "ended_at": None,
        "reason": None,
        "auto_run": True,
    }
    DIALOGUES[dialogue_id] = dialogue

    # Launch background task
    import asyncio
    asyncio.create_task(_run_dialogue_loop(dialogue_id))

    return _serialize_dialogue(dialogue)


@rpc_method("dialogues/status")
async def rpc_dialogues_status(params: dict) -> dict:
    """Get the current status of a dialogue loop."""
    dialogue_id = str(params.get("dialogue_id", "")).strip()
    if not dialogue_id:
        raise HTTPException(status_code=400, detail="dialogue_id is required")
    dialogue = DIALOGUES.get(dialogue_id)
    if not dialogue:
        raise ValueError("Dialogue not found")
    return _serialize_dialogue(dialogue)


@rpc_method("agent/list")
async def rpc_agent_list(params: dict) -> dict:
    agents = await AgentDiscovery.list_available(capability=params.get("capability"))
    return {"agents": agents}


@rpc_method("agent/register")
async def rpc_agent_register(params: dict) -> dict:
    name = params.get("name", "")
    url = params.get("url", "")
    if not name or not url:
        raise HTTPException(status_code=400, detail="name and url are required")
    return await AgentDiscovery.register(name, url)


# ── A2A v1.0 Agent Executor ────────────────────────────


class RoomAgentExecutor(AgentExecutor):
    """Bridges A2A protocol requests to the room/chat system."""

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        """Process an incoming A2A message and produce task results."""
        message = context.message
        text_parts = [
            part.text
            for part in (message.parts or [])
            if part.HasField("text") or part.text
        ]
        query = "\n".join(text_parts) or ""

        meta = getattr(message, 'metadata', None) or {}
        room_id = meta.get("room_id", "")
        source_agent = meta.get("source_agent", "remote-agent")
        target_agent = meta.get("target_agent", "")

        # Submit task through existing task manager
        try:
            task_data = await tm.submit_task(
                query=query,
                target_agent=target_agent or None,
                source_agent=source_agent,
                room_id=room_id or None,
            )
        except Exception as e:
            logger.exception("task submission failed")
            task_data = {"id": str(uuid.uuid4()), "status": "failed", "result": [{"text": str(e)}]}

        # Build response Task
        task = Task()
        task.id = task_data.get("id", str(uuid.uuid4()))
        task.context_id = getattr(context, 'context_id', '') or str(uuid.uuid4())

        result_data = task_data.get("result") or []
        if isinstance(result_data, list) and result_data:
            first = result_data[0] if isinstance(result_data[0], dict) else {}
            response_text = first.get("text", str(task_data.get("status", "")))
        elif isinstance(result_data, dict):
            response_text = result_data.get("error", str(task_data.get("status", "")))
        else:
            response_text = str(task_data.get("status", ""))

        state_map = {
            "completed": TaskState.TASK_STATE_COMPLETED,
            "failed": TaskState.TASK_STATE_FAILED,
            "working": TaskState.TASK_STATE_WORKING,
            "submitted": TaskState.TASK_STATE_SUBMITTED,
        }
        task.status.state = state_map.get(
            task_data.get("status", "submitted"), TaskState.TASK_STATE_SUBMITTED
        )

        artifact = task.artifacts.add()
        part = artifact.parts.add()
        part.text = response_text

        await event_queue.enqueue_event(task)

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        """Cancel a running task."""
        task_id = getattr(context, 'task_id', None)
        if task_id:
            await tm.cancel_task(task_id)


# ── Mount function — called from main.py ───────────────


def mount_a2a(app) -> None:
    """Mount A2A v1.0 protocol routes on the FastAPI app."""
    hub_card = build_hub_card(settings.a2a_public_url)

    task_store = InMemoryTaskStore()
    executor = RoomAgentExecutor()
    handler = DefaultRequestHandler(
        agent_executor=executor,
        task_store=task_store,
        agent_card=hub_card,
    )

    card_routes = create_agent_card_routes(hub_card)
    jsonrpc_routes = create_jsonrpc_routes(handler, rpc_url="/a2a/rpc")

    from a2a.server.routes.fastapi_routes import add_a2a_routes_to_fastapi
    add_a2a_routes_to_fastapi(
        app,
        agent_card_routes=card_routes,
        jsonrpc_routes=jsonrpc_routes,
    )


# Legacy router export for backward compatibility
legacy_router = router
