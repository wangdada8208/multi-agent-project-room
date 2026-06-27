from __future__ import annotations
"""A2A JSON-RPC server — unified entry point for agent communication.

All A2A methods are routed through POST /a2a.
Agent Card is served at GET /a2a/.well-known/agent-card.
"""

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import get_settings
from app.a2a.agent_card import build_hub_card
from app.a2a import task_manager as tm
from app.a2a.discovery import AgentDiscovery
from app.chat import service as chat_service
from app.core.database import async_session
from app.ws.connection_manager import connection_manager

router = APIRouter(prefix="/a2a", tags=["a2a"])
settings = get_settings()


# ── Models ────────────────────────────────────────────


class JSONRPCRequest(BaseModel):
    jsonrpc: str = "2.0"
    method: str
    params: dict = {}
    id: str | int | None = None


class JSONRPCResponse(BaseModel):
    jsonrpc: str = "2.0"
    result: dict | None = None
    error: dict | None = None
    id: str | int | None = None


# ── Agent Card (discovery) ────────────────────────────


@router.get("/.well-known/agent-card")
async def get_agent_card():
    """A2A protocol standard — agent capability discovery endpoint."""
    return build_hub_card(settings.a2a_public_url).model_dump()


# ── JSON-RPC unified entry ────────────────────────────

METHODS: dict[str, callable] = {}
DIALOGUES: dict[str, dict] = {}


def rpc_method(name: str):
    """Decorator: register a JSON-RPC method handler."""
    def wrapper(fn):
        METHODS[name] = fn
        return fn
    return wrapper


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
        print(f"dialogue message persistence failed: {e}")
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


@router.post("")
async def handle_jsonrpc(request: JSONRPCRequest):
    """Single JSON-RPC endpoint for all A2A methods."""
    handler = METHODS.get(request.method)
    if not handler:
        return JSONRPCResponse(
            error={"code": -32601, "message": f"Method not found: {request.method}"},
            id=request.id,
        )
    try:
        result = await handler(request.params)
        return JSONRPCResponse(result=result, id=request.id)
    except HTTPException:
        raise
    except Exception as e:
        return JSONRPCResponse(
            error={"code": -32000, "message": str(e)},
            id=request.id,
        )


# ── Method implementations ────────────────────────────


@rpc_method("tasks/send")
async def rpc_tasks_send(params: dict) -> dict:
    """Submit a task. Routes to target_agent if specified."""
    task_id = params.get("id")
    query = params.get("query", "")
    target = params.get("target_agent")

    if not query:
        raise HTTPException(status_code=400, detail="query is required")

    return await tm.submit_task(
        query=query,
        target_agent=target,
        task_id=task_id,
        room_id=params.get("room_id"),
        source_message_id=params.get("source_message_id"),
        requestor_id=params.get("requestor_id"),
    )


@rpc_method("tasks/get")
async def rpc_tasks_get(params: dict) -> dict | None:
    """Get task status and result."""
    task_id = params.get("id")
    if not task_id:
        raise HTTPException(status_code=400, detail="id is required")
    task = await tm.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@rpc_method("tasks/cancel")
async def rpc_tasks_cancel(params: dict) -> dict:
    """Cancel a running task."""
    task_id = params.get("id")
    if not task_id:
        raise HTTPException(status_code=400, detail="id is required")
    return await tm.cancel_task(task_id)


@rpc_method("tasks/list")
async def rpc_tasks_list(params: dict) -> dict:
    """List tasks with optional status filter."""
    tasks = await tm.list_tasks(
        page=params.get("page", 1),
        limit=params.get("limit", 50),
        status=params.get("status"),
    )
    return {"tasks": tasks, "count": len(tasks)}


@rpc_method("tasks/expire")
async def rpc_tasks_expire(params: dict) -> dict:
    """Expire stale submitted/working tasks now."""
    timeout_seconds = params.get("timeout_seconds")
    return await tm.expire_stale_tasks(timeout_seconds=timeout_seconds)


@rpc_method("message/send")
async def rpc_message_send(params: dict) -> dict:
    """Send a message into a chat room (A2A → Chat bridge)."""
    room_id = params.get("room_id")
    content = params.get("content", "")
    sender_id = params.get("sender_id", "a2a-hub")
    sender_type = params.get("sender_type", "system")
    msg_type = params.get("msg_type", "text")

    if not room_id or not content:
        raise HTTPException(status_code=400, detail="room_id and content are required")

    async with async_session() as db:
        await chat_service.get_or_create_room(
            db, room_id, name=f"Room {room_id[:8]}"
        )
        message = await chat_service.save_message(
            db=db, room_id=room_id, sender_id=sender_id,
            sender_type=sender_type, content=content, msg_type=msg_type,
        )

    await connection_manager.broadcast(
        room_id,
        {"type": "message", "message": message.to_dict()},
    )
    return {"status": "sent", "message_id": message.id}


@rpc_method("dialogues/start")
async def rpc_dialogues_start(params: dict) -> dict:
    """Start a Hub-relayed agent dialogue."""
    room_id = str(params.get("room_id", "")).strip()
    initiator = str(params.get("initiator_agent", "")).strip()
    participants = params.get("participants") or []
    if not room_id or not initiator:
        raise HTTPException(
            status_code=400, detail="room_id and initiator_agent are required"
        )
    if not isinstance(participants, list):
        raise HTTPException(status_code=400, detail="participants must be a list")

    duration_seconds = int(params.get("duration_seconds") or 30)
    max_turns = int(params.get("max_turns") or 8)
    duration_seconds = max(5, min(duration_seconds, 300))
    max_turns = max(1, min(max_turns, 40))
    now = _now()
    dialogue_id = str(params.get("dialogue_id") or uuid.uuid4())
    dialogue = {
        "dialogue_id": dialogue_id,
        "room_id": room_id,
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
        raise HTTPException(
            status_code=400, detail="dialogue requires at least two participants"
        )
    DIALOGUES[dialogue_id] = dialogue
    return _serialize_dialogue(dialogue)


@rpc_method("dialogues/send")
async def rpc_dialogues_send(params: dict) -> dict:
    """Relay a message inside an active dialogue."""
    dialogue_id = str(params.get("dialogue_id", "")).strip()
    content = str(params.get("content", "")).strip()
    sender_id = str(params.get("sender_id", "")).strip()
    sender_name = str(params.get("sender_name", "")).strip()
    if not dialogue_id or not content or not sender_id or not sender_name:
        raise HTTPException(
            status_code=400,
            detail="dialogue_id, content, sender_id, and sender_name are required",
        )

    dialogue = DIALOGUES.get(dialogue_id)
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
    if sender_name.lower() not in {
        participant.lower() for participant in dialogue["participants"]
    }:
        raise ValueError("Sender is not a dialogue participant")

    target_agent = _dialogue_peer(
        dialogue, sender_name, params.get("target_agent")
    )
    if target_agent.lower() not in {
        participant.lower() for participant in dialogue["participants"]
    }:
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
async def rpc_dialogues_end(params: dict) -> dict:
    """End an active dialogue."""
    dialogue_id = str(params.get("dialogue_id", "")).strip()
    if not dialogue_id:
        raise HTTPException(status_code=400, detail="dialogue_id is required")
    dialogue = DIALOGUES.get(dialogue_id)
    if not dialogue:
        raise ValueError("Dialogue not found")
    dialogue["status"] = "ended"
    dialogue["ended_at"] = _now()
    dialogue["reason"] = params.get("reason") or "ended"
    await connection_manager.broadcast(
        dialogue["room_id"],
        {"type": "agent_dialogue_ended", "dialogue": _serialize_dialogue(dialogue)},
    )
    return _serialize_dialogue(dialogue)


@rpc_method("agent/list")
async def rpc_agent_list(params: dict) -> dict:
    """List registered agents."""
    agents = await AgentDiscovery.list_available(
        capability=params.get("capability")
    )
    return {"agents": agents}


@rpc_method("agent/register")
async def rpc_agent_register(params: dict) -> dict:
    """Register a new agent for discovery."""
    name = params.get("name", "")
    url = params.get("url", "")
    if not name or not url:
        raise HTTPException(status_code=400, detail="name and url are required")
    return await AgentDiscovery.register(name, url)
