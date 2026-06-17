from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = defaultdict(set)
        self._participants: dict[str, dict[WebSocket, dict]] = defaultdict(dict)

    async def connect(self, room_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[room_id].add(websocket)

    def disconnect(self, room_id: str, websocket: WebSocket) -> dict | None:
        self._connections[room_id].discard(websocket)
        participant = self._participants[room_id].pop(websocket, None)
        if not self._connections[room_id]:
            self._connections.pop(room_id, None)
            self._participants.pop(room_id, None)
        return participant

    async def identify(
        self,
        room_id: str,
        websocket: WebSocket,
        participant: dict,
    ) -> dict:
        existing = self._participants[room_id].get(websocket)
        normalized = {
            "sender_id": str(participant.get("sender_id") or "anonymous"),
            "sender_name": str(participant.get("sender_name") or participant.get("sender_id") or "Anonymous"),
            "sender_type": str(participant.get("sender_type") or "human"),
            "joined_at": existing.get("joined_at") if existing else datetime.now(timezone.utc).isoformat(),
            "last_seen_at": datetime.now(timezone.utc).isoformat(),
        }
        self._participants[room_id][websocket] = normalized
        return normalized

    def presence_snapshot(self, room_id: str) -> list[dict]:
        seen: dict[str, dict] = {}
        for participant in self._participants.get(room_id, {}).values():
            seen[participant["sender_id"]] = participant
        return list(seen.values())

    async def broadcast(self, room_id: str, payload: dict) -> None:
        stale_connections: list[WebSocket] = []

        for websocket in self._connections.get(room_id, set()).copy():
            try:
                await websocket.send_json(payload)
            except RuntimeError:
                stale_connections.append(websocket)

        for websocket in stale_connections:
            self.disconnect(room_id, websocket)


connection_manager = ConnectionManager()
