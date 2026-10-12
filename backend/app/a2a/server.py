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
from a2a.server.tasks.task_store import TaskStore
from a2a.server.context import ServerCallContext
from a2a.types.a2a_pb2 import ListTasksRequest, ListTasksResponse
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
from app.a2a.task_service import TaskService
from app.a2a.models import A2ATask
from app.a2a.discovery import AgentDiscovery
from app.chat import service as chat_service
from app.chat.models import Message as ChatMessage
from app.core.database import async_session
from app.ws.connection_manager import connection_manager

logger = logging.getLogger(__name__)
settings = get_settings()

# ── Legacy dialogue RPC methods ────────────────────────

router = APIRouter(prefix="/a2a", tags=["a2a-dialogue"])

DIALOGUES: dict[str, dict] = {}


async def _require_dialogue_room_role(db, room_id: str, user_id: str, *, allow_viewer: bool = False):
    """Require an existing room and an explicit permission record for the user."""
    from sqlalchemy import select
    from app.models.room import Room
    from app.models.room_permission import RoomPermission

    room = await db.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    result = await db.execute(select(RoomPermission).where(
        RoomPermission.room_id == room_id,
        RoomPermission.user_id == user_id,
    ))
    permission = result.scalar_one_or_none()
    allowed_roles = {"owner", "member", "viewer"} if allow_viewer else {"owner", "member"}
    if permission is None or permission.role not in allowed_roles:
        message = "Insufficient permission to read dialogue" if allow_viewer else "Requires member or owner role"
        raise HTTPException(status_code=403, detail=message)
    return room, permission


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
    raise DialogueError("target_agent is required for single-participant dialogues")


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
                # Dialogue IDs are not message foreign keys.
                parent_id=dialogue_id if await db.get(ChatMessage, dialogue_id) else None,
            )
            payload = message.to_dict()
            payload["dialogue_id"] = dialogue_id
            return payload
    except Exception:
        logger.warning("dialogue message persistence failed")
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


class DialogueError(ValueError):
    """Public dialogue validation messages; never wrap underlying exceptions."""


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
    except DialogueError as exc:
        return {"jsonrpc": "2.0", "error": {"code": -32000, "message": str(exc)}, "id": request.id}
    except Exception:
        return {"jsonrpc": "2.0", "error": {"code": -32000, "message": "Dialogue unavailable"}, "id": request.id}


@rpc_method("dialogues/create")
async def rpc_dialogues_create(params: dict, user: User) -> dict:
    room_id = str(params.get("room_id", "")).strip()
    if not room_id:
        raise HTTPException(status_code=400, detail="room_id is required")

    from app.models.room import Room
    from app.models.room_permission import RoomPermission
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
            await _require_dialogue_room_role(db, room_id, user.id)

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


@rpc_method("dialogues/start")
async def rpc_dialogues_start(params: dict, user: User) -> dict:
    """Backward-compatible alias for dialogues/create."""
    return await rpc_dialogues_create(params, user)


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
        raise HTTPException(status_code=404, detail="Dialogue not found")

    from app.models.user import User as UserModel

    async with async_session() as db:
        await _require_dialogue_room_role(db, dialogue["room_id"], user.id)

        # Impersonation guard: cannot forge another real user ID as sender_id
        if sender_id != user.id:
            other_user = await db.get(UserModel, sender_id)
            if other_user and other_user.id != user.id:
                raise HTTPException(status_code=403, detail="Impersonation of another user is prohibited")
    if not dialogue or dialogue["status"] != "active":
        raise DialogueError("Dialogue is not active")
    if _now() >= dialogue["expires_at"]:
        dialogue["status"] = "ended"
        dialogue["ended_at"] = _now()
        dialogue["reason"] = "expired"
        raise DialogueError("Dialogue is not active")
    if dialogue["current_turn"] >= dialogue["max_turns"]:
        dialogue["status"] = "ended"
        dialogue["ended_at"] = _now()
        dialogue["reason"] = "max_turns_reached"
        raise DialogueError("Dialogue is not active")
    if sender_name.lower() not in {p.lower() for p in dialogue["participants"]}:
        raise DialogueError("Sender is not a dialogue participant")

    target_agent = _dialogue_peer(dialogue, sender_name, params.get("target_agent"))
    if target_agent.lower() not in {p.lower() for p in dialogue["participants"]}:
        raise DialogueError("target_agent is not a dialogue participant")

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
        raise DialogueError("Dialogue not found")

    async with async_session() as db:
        await _require_dialogue_room_role(db, dialogue["room_id"], user.id)
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

    Uses the standard client and its pinned-IP egress policy.
    """
    agents = await AgentDiscovery.list_available()
    target = next(
        (a for a in agents if a["name"].lower() == agent_name.lower()), None
    )
    if not target or not target.get("url") or target["url"].startswith("local://"):
        return f"[{agent_name}] 未配置可调用的标准远端，尚未取得真实回复。"

    try:
        from app.a2a.client import A2AClient
        client = A2AClient(target["url"])
        try:
            result = await client.send_task(prompt, return_immediately=False)
        finally:
            await client.close()
        if not result or result.get("status") == "failed":
            return f"[{agent_name}] 无法连接或任务失败，尚未取得回复。"
        if result.get("status") == "canceled":
            return f"[{agent_name}] 任务已取消，尚未取得最终回复。"
        if result.get("status") in {"submitted", "queued", "working"}:
            return f"[{agent_name}] 任务仍在处理中，尚未取得最终回复。"
        artifacts = result.get("artifacts", [])
        if artifacts and isinstance(artifacts, list):
            first = artifacts[0]
            if isinstance(first, dict):
                parts = first.get("parts", [])
                texts = [part.get("text") for part in parts if isinstance(part, dict) and isinstance(part.get("text"), str)]
                if texts:
                    return "\n".join(texts)
                if parts and isinstance(parts[0], str):
                    return parts[0]  # Keep legacy caller-facing artifact compatibility.
        return f"[{agent_name}] 已处理任务（无文本返回）"
    except Exception:
        logger.warning("Failed to reach agent %s; unsafe or unavailable endpoint", agent_name)
        return f"[{agent_name}] 无法连接，尚未取得回复。"


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

                from sqlalchemy import func, select
                from app.chat.delivery_service import slug
                async with async_session() as db:
                    target_slug = slug(agent_name)
                    target_clean = agent_name.strip().lower()
                    stmt = select(User).where(
                        (func.lower(User.username) == target_clean)
                        | (func.lower(func.replace(User.username, " ", "_")) == target_slug)
                        | (User.id == agent_name)
                    )
                    identities = (await db.execute(stmt)).scalars().all()
                    matches = [actor for actor in identities if slug(actor.username) == target_slug]
                    if not matches and target_slug == "hub":
                        continue  # Hub is a control initiator, not a remote executor.
                    if len(matches) != 1 or matches[0].user_type != "agent":
                        dialogue.update(status="ended", reason="agent_identity_missing", ended_at=_now())
                        break
                    execution_agent = matches[0]
                    await _require_dialogue_room_role(db, room_id, execution_agent.id)
                    if dialogue.get("created_by_user_id"):
                        await _require_dialogue_room_role(db, room_id, dialogue["created_by_user_id"])

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

                # Owner may stop while the remote call is in flight.
                if dialogue["status"] != "active":
                    break

                async with async_session() as db:
                    await _require_dialogue_room_role(db, room_id, execution_agent.id)
                    if dialogue.get("created_by_user_id"):
                        await _require_dialogue_room_role(db, room_id, dialogue["created_by_user_id"])

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
                # Save to room as chat message
                message_payload = await _save_room_message(
                    room_id=room_id,
                    sender_id=execution_agent.id,
                    sender_name=agent_name,
                    content=response_text,
                    dialogue_id=dialogue_id,
                )
                if message_payload.get("persistence") == "failed":
                    dialogue.update(status="ended", reason="persistence_failed", ended_at=_now())
                    break
                dialogue["turns"].append(turn_data)

                # Broadcast to WebSocket
                await connection_manager.broadcast(room_id, {
                    "type": "message",
                    "message": message_payload,
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

    except HTTPException:
        dialogue.update(status="ended", reason="access_revoked", ended_at=_now())
    finally:
        RUNNING_LOOPS.discard(dialogue_id)
        await connection_manager.broadcast(room_id, {
            "type": "agent_dialogue_ended",
            "dialogue": _serialize_dialogue(dialogue),
        })


@rpc_method("dialogues/run")
async def rpc_dialogues_run(params: dict, user: User) -> dict:
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
    async with async_session() as db:
        await _require_dialogue_room_role(db, room_id, user.id)

    now = _now()
    dialogue_id = str(uuid.uuid4())
    all_participants = _normalize_participants(participants, initiator)

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
        "created_by_user_id": user.id,
    }
    DIALOGUES[dialogue_id] = dialogue

    # Launch background task
    import asyncio
    asyncio.create_task(_run_dialogue_loop(dialogue_id))

    return _serialize_dialogue(dialogue)


@rpc_method("dialogues/status")
async def rpc_dialogues_status(params: dict, user: User) -> dict:
    """Get the current status of a dialogue loop."""
    dialogue_id = str(params.get("dialogue_id", "")).strip()
    if not dialogue_id:
        raise HTTPException(status_code=400, detail="dialogue_id is required")
    dialogue = DIALOGUES.get(dialogue_id)
    if not dialogue:
        raise HTTPException(status_code=404, detail="Dialogue not found")
    async with async_session() as db:
        await _require_dialogue_room_role(
            db, dialogue["room_id"], user.id, allow_viewer=True,
        )
    return _serialize_dialogue(dialogue)


@rpc_method("agent/list")
async def rpc_agent_list(params: dict) -> dict:
    agents = await AgentDiscovery.list_available(capability=params.get("capability"))
    return {"agents": agents}


@rpc_method("agent/register")
async def rpc_agent_register(params: dict, user: User) -> dict:
    from app.agent.service import authorize_agent_registration

    name = params.get("name", "")
    url = params.get("url", "")
    if not name or not url:
        raise HTTPException(status_code=400, detail="name and url are required")
    async with async_session() as db:
        name = await authorize_agent_registration(db, user, name)
    return await AgentDiscovery.register(name, url, agent_user_id=user.id)


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
        except Exception:
            logger.warning("task submission failed; details suppressed")
            task_data = {"id": str(uuid.uuid4()), "status": "failed", "result": [{"text": "Task submission failed"}]}

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


_STATUS_TO_TASK_STATE = {
    "submitted": TaskState.TASK_STATE_SUBMITTED,
    "queued": TaskState.TASK_STATE_SUBMITTED,
    "working": TaskState.TASK_STATE_WORKING,
    "completed": TaskState.TASK_STATE_COMPLETED,
    "failed": TaskState.TASK_STATE_FAILED,
    "canceled": TaskState.TASK_STATE_CANCELED,
    "input_required": TaskState.TASK_STATE_INPUT_REQUIRED,
}

_TASK_STATE_TO_STATUS = {
    TaskState.TASK_STATE_SUBMITTED: "submitted",
    TaskState.TASK_STATE_WORKING: "working",
    TaskState.TASK_STATE_COMPLETED: "completed",
    TaskState.TASK_STATE_FAILED: "failed",
    TaskState.TASK_STATE_CANCELED: "canceled",
    TaskState.TASK_STATE_INPUT_REQUIRED: "input_required",
}


class TaskServiceTaskStore(TaskStore):
    """Adapter bridging A2A SDK TaskStore to unified SQL TaskService & A2ATask."""

    async def get(
        self, task_id: str, context: Optional[ServerCallContext] = None
    ) -> Optional[Task]:
        async with async_session() as session:
            db_task = await TaskService.get_task(session, task_id)
            if not db_task:
                return None
            return self._to_sdk_task(db_task)

    async def save(
        self, task: Task, context: Optional[ServerCallContext] = None
    ) -> None:
        target_status = _TASK_STATE_TO_STATUS.get(
            task.status.state, "submitted"
        )
        result_data = None
        if task.artifacts:
            arts = []
            for art in task.artifacts:
                art_dict = {"parts": []}
                for part in art.parts:
                    if part.HasField("text") or part.text:
                        art_dict["parts"].append({"text": part.text})
                arts.append(art_dict)
            result_data = arts

        async with async_session() as session:
            db_task = await TaskService.get_task(session, task.id)
            if not db_task:
                query = ""
                if task.history:
                    for msg in task.history:
                        for part in msg.parts:
                            if part.HasField("text") or part.text:
                                query = part.text
                                break
                        if query:
                            break
                if not query:
                    query = f"Task {task.id}"

                await TaskService.create_task(
                    session,
                    task_id=task.id,
                    query=query,
                    context_id=task.context_id or None,
                    initial_status="submitted",
                )
                if target_status == "working":
                    await TaskService.start_task(session, task.id)
                elif target_status == "completed":
                    completed, _, code = await TaskService.complete_task(session, task.id, result_data)
                    if code == 'completed' and result_data:
                        from app.a2a.task_service import _append_event
                        for index in range(len(result_data)):
                            await _append_event(session, task.id, 'artifact_update', {'artifact_index': index})
                elif target_status == "failed":
                    await TaskService.fail_task(
                        session, task.id, str(result_data or "Task failed")
                    )
                elif target_status == "canceled":
                    await TaskService.cancel_task(session, task.id)
            else:
                if target_status == "working":
                    await TaskService.start_task(session, task.id)
                elif target_status == "completed":
                    completed, _, code = await TaskService.complete_task(session, task.id, result_data)
                    if code == 'completed' and result_data:
                        from app.a2a.task_service import _append_event
                        for index in range(len(result_data)):
                            await _append_event(session, task.id, 'artifact_update', {'artifact_index': index})
                elif target_status == "failed":
                    await TaskService.fail_task(
                        session, task.id, str(result_data or "Task failed")
                    )
                elif target_status == "canceled":
                    await TaskService.cancel_task(session, task.id)
            await session.commit()

    async def list(
        self,
        params: ListTasksRequest,
        context: Optional[ServerCallContext] = None,
    ) -> ListTasksResponse:
        async with async_session() as session:
            db_tasks = await TaskService.list_tasks(session, page=1, limit=100)
            sdk_tasks = [self._to_sdk_task(t) for t in db_tasks]
            resp = ListTasksResponse()
            resp.tasks.extend(sdk_tasks)
            return resp

    async def delete(
        self, task_id: str, context: Optional[ServerCallContext] = None
    ) -> None:
        async with async_session() as session:
            await TaskService.cancel_task(
                session, task_id, reason="deleted_via_task_store"
            )
            await session.commit()

    @staticmethod
    def _to_sdk_task(db_task: A2ATask) -> Task:
        sdk_task = Task()
        sdk_task.id = db_task.id
        if db_task.context_id:
            sdk_task.context_id = db_task.context_id
        sdk_task.status.state = _STATUS_TO_TASK_STATE.get(
            db_task.status, TaskState.TASK_STATE_SUBMITTED
        )
        if db_task.completed_at or db_task.created_at:
            sdk_task.status.timestamp.FromDatetime(db_task.completed_at or db_task.created_at)
        if db_task.result:
            if isinstance(db_task.result, list):
                for index, item in enumerate(db_task.result):
                    art = sdk_task.artifacts.add()
                    art.artifact_id = f"{db_task.id}:{index}"
                    if isinstance(item, dict) and "parts" in item:
                        for p in item["parts"]:
                            part = art.parts.add()
                            if isinstance(p, dict):
                                part.text = str(p.get("text", ""))
                            else:
                                part.text = str(p)
                    elif isinstance(item, dict) and "text" in item:
                        part = art.parts.add()
                        part.text = str(item["text"])
                    elif isinstance(item, dict) and "content" in item:
                        part = art.parts.add()
                        part.text = str(item["content"])
                    else:
                        part = art.parts.add()
                        part.text = str(item)
            elif isinstance(db_task.result, dict):
                art = sdk_task.artifacts.add()
                art.artifact_id = f"{db_task.id}:0"
                part = art.parts.add()
                part.text = str(
                    db_task.result.get("text", db_task.result.get("error", ""))
                )
        return sdk_task


def mount_a2a(app) -> None:
    """Mount A2A v1.0 protocol routes on the FastAPI app."""
    hub_card = build_hub_card(settings.a2a_public_url)

    task_store = TaskServiceTaskStore()
    executor = RoomAgentExecutor()
    from app.a2a.http_protocol import SQLRequestHandler, protocol_routes
    handler = SQLRequestHandler(
        agent_executor=executor,
        task_store=task_store,
        agent_card=hub_card,
    )

    card_routes = create_agent_card_routes(hub_card)
    jsonrpc_routes = protocol_routes(handler)

    from a2a.server.routes.fastapi_routes import add_a2a_routes_to_fastapi
    add_a2a_routes_to_fastapi(
        app,
        agent_card_routes=card_routes,
        jsonrpc_routes=jsonrpc_routes,
    )


# Legacy router export for backward compatibility
legacy_router = router
