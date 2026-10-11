"""Bounded cross-Hub room delivery/presence; DB authority, one shared PG bus.

No DB session survives a network send. Counter allocation in models.py makes
room_seq a commit-consistent cursor. Socket cursors advance ONLY after a checked
send, and local broadcasts enter this same pipeline to avoid ordering races.
"""
import asyncio
from contextlib import asynccontextmanager
import logging
import random
import time
import uuid
from datetime import timedelta

from sqlalchemy import select, delete, update, func
from app.chat.models import Message
from app.chat.service import retention_cutoff
from app.chat.pg_wakeup import signal_in_transaction
from app.chat.delivery_service import aware
from app.models.room import Room
from app.models.room_presence import RoomPresence as Presence
from app.models.room_permission import RoomPermission as Permission
from app.models.user import User

logger = logging.getLogger(__name__)


class RoomSynchronizer:
    def __init__(self, sessions, manager, *, interval=1.0, batch=50, ttl=30, connection_batch=16):
        if not 0 < interval <= 10 or not 1 <= batch <= 100 or ttl < 2 or not 1 <= connection_batch <= 32:
            raise ValueError("Invalid room synchronization bounds")
        self.sessions, self.manager = sessions, manager
        self.interval, self.batch, self.ttl, self.connection_batch = interval, batch, ttl, connection_batch
        self.hub_id = str(uuid.uuid4())
        self.event, self.lock = asyncio.Event(), asyncio.Lock()
        self.running = False
        self.task = None
        self.states = {}  # ws -> cursor, next heartbeat, last snapshot
        self.leases = {}  # connection_id -> room_id; only leases actually created by us
        self.offset = 0

    def wake(self):
        self.event.set()

    def set_cursor(self, ws, cursor):
        state = self.states.setdefault(ws, {"cursor": 0, "heartbeat": 0, "snapshot": None, "generation": 0, "metadata": None})
        state["cursor"] = cursor
        state["generation"] += 1
        self.wake()

    def start(self):
        if not self.task:
            self.running = True
            self.manager.room_sync = self
            self.task = asyncio.create_task(self._run(), name="room-reconciliation")
            self.wake()

    @asynccontextmanager
    async def _session(self):
        # Await completion, not just scheduling, of close when cancelled. This
        # prevents a background rollback racing shutdown cleanup/fixture teardown.
        db = self.sessions()
        try:
            yield db
        finally:
            closing = asyncio.create_task(db.close())
            try:
                await asyncio.shield(closing)
            except asyncio.CancelledError:
                await closing
                raise

    async def stop(self):
        cancelled = False
        self.running = False
        self.wake()
        if self.task:
            task = self.task
            try:
                # Finish the current bounded scan first; do not create an orphan
                # session close by immediately cancelling normal shutdown.
                await asyncio.wait_for(asyncio.shield(task), 6)
            except asyncio.TimeoutError:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            except asyncio.CancelledError:
                cancelled = bool(asyncio.current_task().cancelling())
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            self.task = None
        self.manager.room_sync = None
        try:
            async with asyncio.timeout(3):
                async with self._session() as db:
                    rooms = set(self.leases.values())
                    await db.execute(delete(Presence).where(Presence.hub_id == self.hub_id))
                    for room in rooms:
                        await signal_in_transaction(db, "room", room)
                    await db.commit()
        except Exception:
            logger.warning("Presence shutdown cleanup unavailable; leases expire by DB TTL")
        self.leases.clear()
        self.states.clear()
        if cancelled:
            raise asyncio.CancelledError()

    async def _run(self):
        failures = 0
        while self.running:
            self.event.clear()
            try:
                await asyncio.wait_for(self.run_once(), 5)
                failures = 0
            except asyncio.CancelledError:
                raise
            except Exception:
                failures += 1
                logger.warning("Room reconciliation failed; bounded retry scheduled")
            if not self.running:
                break
            await asyncio.sleep(.05)
            try:
                await asyncio.wait_for(self.event.wait(), min(10, self.interval * 2 ** min(4, failures)) + random.uniform(0, .1))
            except asyncio.TimeoutError:
                pass

    async def _close(self, ws, room):
        self.manager.disconnect(room, ws)
        try:
            await asyncio.wait_for(ws.close(code=4003, reason="Room access or presence lease expired"), 1)
        except Exception:
            pass

    async def _authorized(self, ws):
        check = self.manager._authorization_checks.get(ws)
        try:
            return bool(check and await asyncio.wait_for(check(), 2))
        except Exception:
            return False

    async def run_once(self):
        async with self.lock:
            live = [(ws, entry) for ws, entry in list(self.manager.online.items()) if not entry[0].startswith("_agent_")]
            live_ids = {entry[2] for _, entry in live}
            live_ws = {ws for ws, _ in live}
            self.states = {ws: state for ws, state in self.states.items() if ws in live_ws}
            # Delete our disconnected leases; reap at most 100 expired leases across
            # hubs per pass. Expiry predicate in DELETE protects concurrent renewal.
            async with self._session() as db:
                stamp = aware((await db.execute(select(func.current_timestamp()))).scalar_one())
                stale = list((await db.execute(select(Presence.connection_id).where(
                    Presence.lease_until <= stamp).limit(100))).scalars())
                departed = set(self.leases) - live_ids
                rooms = {self.leases[cid] for cid in departed}
                if departed:
                    await db.execute(delete(Presence).where(Presence.hub_id == self.hub_id,
                                                           Presence.connection_id.in_(departed)))
                if stale:
                    rooms.update((await db.execute(select(Presence.room_id).where(
                        Presence.connection_id.in_(stale)))).scalars())
                    await db.execute(delete(Presence).where(Presence.connection_id.in_(stale), Presence.lease_until <= stamp))
                for room in rooms:
                    await signal_in_transaction(db, "room", room)
                await db.commit()
            for cid in departed:
                self.leases.pop(cid, None)
            if not live:
                return 0
            start = self.offset % len(live)
            chosen = (live[start:] + live[:start])[:self.connection_batch]
            self.offset = (start + len(chosen)) % len(live)
            count = 0
            for ws, (room_id, user_id, cid) in chosen:
                # Idle clients also get checked, even with no message/presence delta.
                if not await self._authorized(ws):
                    await self._close(ws, room_id)
                    continue
                state = self.states.setdefault(ws, {"cursor": 0, "heartbeat": 0, "snapshot": None, "generation": 0, "metadata": None})
                generation = state["generation"]
                expired = False
                async with self._session() as db:
                    room = await db.get(Room, room_id)
                    if not room or not room.is_active:
                        expired = True
                        frames, snapshot = [], None
                    else:
                        if time.monotonic() >= state["heartbeat"]:
                            stamp = aware((await db.execute(select(func.current_timestamp()))).scalar_one())
                            if cid not in self.leases:
                                db.add(Presence(connection_id=cid, room_id=room_id, user_id=user_id,
                                    hub_id=self.hub_id, joined_at=stamp, last_seen_at=stamp,
                                    lease_until=stamp + timedelta(seconds=self.ttl)))
                                await db.flush()
                            else:
                                changed = await db.execute(update(Presence).where(
                                    Presence.connection_id == cid, Presence.hub_id == self.hub_id,
                                    Presence.room_id == room_id, Presence.user_id == user_id,
                                    Presence.lease_until > stamp).values(last_seen_at=stamp,
                                        lease_until=stamp + timedelta(seconds=self.ttl)))
                                expired = changed.rowcount != 1
                            if not expired:
                                await signal_in_transaction(db, "room", room_id)
                                await db.commit()
                                self.leases[cid] = room_id
                                state["heartbeat"] = time.monotonic() + self.ttl / 3
                        frames = []
                        if not expired and room.transport == "hub":
                            frames = [{"type": "message", "message": row.to_dict()} for row in (await db.execute(
                                select(Message).where(Message.room_id == room_id,
                                    Message.room_seq > state["cursor"], Message.created_at >= retention_cutoff())
                                .order_by(Message.room_seq).limit(self.batch))).scalars()]
                        snapshot = await self.snapshot(db, room_id) if not expired else None
                        permission = (await db.execute(select(Permission).where(
                            Permission.room_id == room_id, Permission.user_id == user_id))).scalar_one_or_none()
                        metadata = {"type": "room_updated", "room": room.to_dict(),
                                    "role": permission.role if permission else None}
                # Pool connection returned BEFORE WS I/O; each frame rechecks JWT/RBAC.
                if expired:
                    await self._close(ws, room_id)
                    continue
                for frame in frames:
                    if generation != state["generation"]:
                        self.wake()
                        break
                    if not await self.manager.send_checked(ws, frame):
                        break
                    if generation == state["generation"]:
                        state["cursor"] = frame["message"]["room_seq"]
                    count += 1
                if metadata != state["metadata"] and await self.manager.send_checked(ws, metadata):
                    state["metadata"] = metadata
                if snapshot != state["snapshot"] and await self.manager.send_checked(ws, snapshot):
                    state["snapshot"] = snapshot
                if len(frames) == self.batch:
                    self.wake()
            return count

    @staticmethod
    async def snapshot(db, room_id):
        eligible = (Presence.room_id == room_id, Presence.lease_until > func.current_timestamp(),
                    Permission.role.in_(("owner", "member", "viewer")), Room.is_active.is_(True))
        base = select(User.id, User.display_name, User.username, User.user_type,
                      func.min(Presence.joined_at), func.max(Presence.last_seen_at), func.count())\
            .join(Presence, Presence.user_id == User.id)\
            .join(Permission, (Permission.room_id == Presence.room_id) & (Permission.user_id == User.id))\
            .join(Room, Room.id == Presence.room_id).where(*eligible)\
            .group_by(User.id, User.display_name, User.username, User.user_type)
        total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()
        participants = [{"sender_id": uid, "sender_name": username if typ == "agent" else name,
                         "sender_type": typ, "joined_at": aware(joined).isoformat(),
                         "last_seen_at": aware(seen).isoformat(), "connection_count": connections}
                        for uid, name, username, typ, joined, seen, connections in
                        (await db.execute(base.order_by(User.id).limit(200))).all()]
        return {"type": "presence_snapshot", "participants": participants,
                "online_count": total, "truncated": total > len(participants)}
