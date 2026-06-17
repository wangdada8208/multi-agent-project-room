"""WebSocket chat handler with PostgreSQL persistence.

Message flow:
  Client sends JSON → server persists to DB → server broadcasts to room

Cross-room @mention flow:
  User sends "@Claude ..." in Room A
    → backend saves + broadcasts to Room A
    → backend detects @Claude
    → backend forwards as agent_task to _agent_claude channel
    → adapter (on _agent_claude) receives, processes
    → adapter responds with target_room=Room A
    → backend routes response to Room A
"""

import json
import logging
import re

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.core.database import async_session
from app.chat import service as chat_service
from app.a2a import task_manager as tm
from app.ws.connection_manager import connection_manager
from app.models.room import Room
from app.models.agent_card import AgentCardRecord

logger = logging.getLogger(__name__)


def _find_mentioned_agents(content: str, agent_names: set[str]) -> list[str]:
    """Case-insensitive @mention detection. Returns matched agent names."""
    content_lower = content.lower()
    mentioned = []
    for name in agent_names:
        if re.search(rf'@{re.escape(name.lower())}\b', content_lower):
            mentioned.append(name)
    return mentioned


async def _get_active_agent_names() -> set[str]:
    """Query all active agent names from the AgentCardRecord table."""
    async with async_session() as db:
        result = await db.execute(
            select(AgentCardRecord.agent_name).where(
                AgentCardRecord.is_active == True
            )
        )
        return {row[0] for row in result.fetchall()}


async def _check_mentions_and_forward(
    source_room_id: str,
    message,
    content: str,
) -> None:
    """Detect @mentions and forward agent_task messages to agent channels."""
    agent_names = await _get_active_agent_names()
    mentioned = _find_mentioned_agents(content, agent_names)
    if not mentioned:
        return

    for agent_name in mentioned:
        task = await tm.submit_task(
            query=content,
            target_agent=agent_name,
            source_agent=message.sender_name or message.sender_id,
            room_id=source_room_id,
            source_message_id=message.id,
        )
        agent_channel = f"_agent_{agent_name.lower()}"
        task_content = json.dumps({
            "origin_room": source_room_id,
            "original_id": message.id,
            "task_id": task["id"],
            "original_content": content,
            "original_sender": message.sender_name or message.sender_id,
        }, ensure_ascii=False)

        async with async_session() as db:
            await chat_service.save_message(
                db=db,
                room_id=agent_channel,
                sender_id=message.sender_id,
                sender_type="system",
                content=task_content,
                msg_type="task",
                parent_id=message.id,
            )

        await connection_manager.broadcast(agent_channel, {
            "type": "agent_task",
            "task_id": task["id"],
            "message_id": message.id,
            "content": content,
            "sender_id": message.sender_id,
            "sender_name": message.sender_name,
            "origin_room": source_room_id,
        })


async def handle_chat(websocket: WebSocket, room_id: str) -> None:
    """WebSocket endpoint for a chat room.

    Wire this in main.py:
        app.add_websocket_route("/ws/chat/{room_id}", handle_chat)
    """
    await connection_manager.connect(room_id, websocket)
    logger.info("ws connected room=%s", room_id)
    await websocket.send_json(
        {
            "type": "presence_snapshot",
            "participants": connection_manager.presence_snapshot(room_id),
        }
    )

    await connection_manager.broadcast(
        room_id,
        {"type": "system", "content": "A participant joined the room."},
    )

    try:
        while True:
            raw = await websocket.receive_json()
            msg_type = raw.get("type", "")

            # ── Heartbeat ──
            if msg_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            # ── Presence identity ──
            if msg_type == "identify":
                participant = await connection_manager.identify(room_id, websocket, raw)
                await connection_manager.broadcast(
                    room_id,
                    {"type": "user_online", "participant": participant},
                )
                await websocket.send_json(
                    {
                        "type": "presence_snapshot",
                        "participants": connection_manager.presence_snapshot(room_id),
                    }
                )
                continue

            # ── Typing indicator ──
            if msg_type == "typing":
                await connection_manager.broadcast(
                    room_id,
                    {"type": "typing", "sender_id": raw.get("sender_id", "anonymous")},
                )
                continue

            # ── Chat message ──
            if msg_type == "message":
                participant = await connection_manager.identify(room_id, websocket, raw)
                content = str(raw.get("content", "")).strip()
                if not content:
                    await websocket.send_json(
                        {"type": "error", "message": "content is required"}
                    )
                    continue

                # Agent responses include target_room for cross-room routing
                target_room = raw.get("target_room") or room_id

                async with async_session() as db:
                    # Ensure target room exists
                    room = await db.get(Room, target_room)
                    if room is None:
                        room = await chat_service.get_or_create_room(
                            db, target_room, name=f"Room {target_room[:8]}"
                        )

                    message = await chat_service.save_message(
                        db=db,
                        room_id=target_room,
                        sender_id=str(raw.get("sender_id", "anonymous")),
                        sender_type=raw.get("sender_type", "human"),
                        sender_name=raw.get("sender_name"),
                        content=content,
                        msg_type=raw.get("msg_type", "text"),
                        parent_id=raw.get("parent_id"),
                    )

                await connection_manager.broadcast(
                    target_room,
                    {"type": "message", "message": message.to_dict()},
                )

                task_id = raw.get("task_id")
                if task_id and raw.get("sender_type") == "agent":
                    await tm.complete_task(
                        str(task_id),
                        [{
                            "type": raw.get("msg_type", "report"),
                            "content": content,
                            "message_id": message.id,
                        }],
                    )

                # @mention detection — skip for agent channel traffic
                # (prevents infinite loops when agents mention each other)
                if not room_id.startswith("_agent_"):
                    await _check_mentions_and_forward(
                        target_room, message, content
                    )

    except WebSocketDisconnect:
        participant = connection_manager.disconnect(room_id, websocket)
        logger.info("ws disconnected room=%s participant=%s", room_id, participant)
        if participant:
            await connection_manager.broadcast(
                room_id,
                {"type": "user_offline", "participant": participant},
            )
        await connection_manager.broadcast(
            room_id,
            {"type": "system", "content": "A participant left the room."},
        )
    except Exception as e:
        participant = connection_manager.disconnect(room_id, websocket)
        logger.exception("ws error room=%s", room_id)
        if participant:
            await connection_manager.broadcast(
                room_id,
                {"type": "user_offline", "participant": participant},
            )
        await connection_manager.broadcast(
            room_id,
            {"type": "system", "content": f"Connection error: {str(e)}"},
        )
