from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from collections import defaultdict
from datetime import datetime, timezone

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self.room_sync = None
        self.on_change = None
        self.online = {}
        self.send_timeout = 2.0
        self._connections: dict[str, set[WebSocket]] = defaultdict(set)
        self._participants: dict[str, dict[WebSocket, dict]] = defaultdict(dict)
        self._authorization_checks: dict[WebSocket, Callable[[], Awaitable[bool]]] = {}

    async def connect(self, room_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[room_id].add(websocket)

    def set_authorization_check(self, websocket: WebSocket, authorize: Callable[[], Awaitable[bool]]) -> None:
        self._authorization_checks[websocket] = authorize

    def register(self, websocket, channel, user_id, connection_id):
        self.online[websocket] = (channel, user_id, connection_id)
        if self.on_change:
            self.on_change()
        if self.room_sync:
            self.room_sync.wake()

    async def send_checked(self, websocket, payload):
        entry = self.online.get(websocket)
        if not entry:
            return False
        try:
            async def send():
                check = self._authorization_checks.get(websocket)
                if check is None or not await check():
                    raise PermissionError()
                await websocket.send_json(payload)
            await asyncio.wait_for(send(), min(self.send_timeout, 3.0))
            return True
        except Exception:
            self.disconnect(entry[0], websocket)
            try:
                await asyncio.wait_for(websocket.close(code=1011), 1.0)
            except Exception:
                pass
            return False

    def disconnect(self, room_id: str, websocket: WebSocket) -> dict | None:
        self.online.pop(websocket, None)
        self._connections[room_id].discard(websocket)
        self._authorization_checks.pop(websocket, None)
        participant = self._participants[room_id].pop(websocket, None)
        if not self._connections[room_id]:
            self._connections.pop(room_id, None)
            self._participants.pop(room_id, None)
        if self.room_sync:
            self.room_sync.wake()
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

    def get_online_agent_names(self, room_id: str | None = None) -> set[str]:
        """Return distinct agent names currently connected via WebSocket."""
        names: set[str] = set()
        rooms = [room_id] if room_id else list(self._participants.keys())
        for r in rooms:
            for p in self._participants.get(r, {}).values():
                if p.get("sender_type") == "agent" and p.get("sender_name"):
                    names.add(p["sender_name"])
        return names

    async def broadcast(self, room_id: str, payload: dict) -> None:
        if self.room_sync and not room_id.startswith("_agent_") and payload.get("type") in {"message", "presence_snapshot", "user_online", "user_offline"}:
            self.room_sync.wake()
            return
        async def send_one(websocket):
            try:
                async def checked_send():
                    authorize = self._authorization_checks.get(websocket)
                    if authorize is not None and not await authorize():
                        raise PermissionError()
                    await websocket.send_json(payload)
                await asyncio.wait_for(checked_send(), timeout=min(self.send_timeout, 3.0))
            except Exception:
                # One stalled/broken client must not delay delivery to the others.
                self.disconnect(room_id, websocket)
                try:
                    await asyncio.wait_for(websocket.close(code=1011), timeout=min(self.send_timeout, 3.0))
                except Exception:
                    pass

        await asyncio.gather(*(send_one(ws) for ws in self._connections.get(room_id, set()).copy()))

    def reset(self) -> None:
        self.online.clear()
        self._connections.clear()
        self._participants.clear()
        self._authorization_checks.clear()


connection_manager = ConnectionManager()
