"""Bounded database reconciliation; NOTIFY is only an optional wakeup hint."""
import asyncio
import logging
import random
from collections import OrderedDict
from datetime import timedelta

from sqlalchemy import select, update, func, or_

from app.a2a.models import A2ATask, TaskEvent
from app.a2a.task_service import ACTIVE_STATUSES
from app.chat import delivery_service as ds
from app.chat.pg_wakeup import PgWakeup, CHANNEL
from app.models.agent_task_delivery import AgentTaskDelivery as Delivery

logger = logging.getLogger(__name__)


class TaskReconciler:
    def __init__(self, sessions, manager, database_url, interval=1.0, batch=50, room_sync=None):
        if interval <= 0 or not 1 <= batch <= 50:
            raise ValueError("Invalid reconciliation bounds")
        self.room_sync = room_sync
        self.sessions, self.manager = sessions, manager
        self.database_url, self.interval, self.batch = database_url, interval, batch
        self.event = asyncio.Event()
        self.tasks = []
        self.wakeup = PgWakeup(database_url, reconcile_interval=10 + random.random(),
                               retry_min=random.uniform(.2, .4), callback_timeout=5)
        self.scan_lock = asyncio.Lock()
        self.cursors = {}
        self.bounds = {}
        self.sent = OrderedDict()
        self.offset = 0

    def wake(self):
        self.event.set()

    def start(self):
        if not self.tasks:
            self.manager.on_change = self.wake
            self.tasks = [asyncio.create_task(self._run(), name="task-reconciliation")]
            self.tasks.append(asyncio.create_task(
                self.wakeup.start(self._on_hint, self._on_reconcile), name="task-wakeup-start"))
            self.wake()

    async def stop(self):
        self.manager.on_change = None
        tasks, self.tasks = self.tasks, []
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.wakeup.stop()
        self.cursors.clear()
        self.bounds.clear()
        self.sent.clear()

    @property
    def listener_ready(self):
        return self.wakeup.listening

    async def _on_hint(self, hint):
        # Hints do not carry authority or task bodies. Coalesce and reread DB.
        self.wake()
        if self.room_sync:
            self.room_sync.wake()

    async def _on_reconcile(self):
        # PgWakeup invokes this after LISTEN and on recovery. Serialize it with
        # our jittered periodic worker; neither path owns a second listener.
        await self.run_once()
        if self.room_sync:
            await self.room_sync.run_once()
            self.room_sync.wake()
        self.wake()

    async def _run(self):
        failures = 0
        while True:
            self.event.clear()
            try:
                await asyncio.wait_for(self.run_once(), 5)
                failures = 0
            except asyncio.CancelledError:
                raise
            except Exception:
                failures += 1
                logger.warning("Task reconciliation failed; bounded retry scheduled")
            # Coalesce bursts, cap scan rate and continue polling without notifications.
            await asyncio.sleep(.05)
            try:
                await asyncio.wait_for(self.event.wait(),
                    min(10, self.interval * 2 ** min(failures, 4)) + random.uniform(0, .1))
            except asyncio.TimeoutError:
                pass

    async def _repair_offer(self, delivery_id, expected_attempt):
        """True dispatch only when no live offer exists, never on each wake/replay."""
        async with self.sessions() as db:
            row = await db.get(Delivery, delivery_id)
            if not row:
                return None
            await db.execute(update(A2ATask).where(A2ATask.id == row.task_id)
                             .values(event_seq=A2ATask.event_seq))
            await db.refresh(row)
            if (row.state != "pending" or row.attempt != expected_attempt or
                    (row.delivered_at and ds.aware(row.delivered_at) + timedelta(seconds=ds.LEASE_SECONDS) > ds.now())):
                return None
            frame = await ds.offer(db, row)
            await db.commit()
            return frame

    async def run_once(self):
        async with self.scan_lock:
            return await self._scan()

    async def _scan(self):
        live = list(self.manager.online.items())
        live_sockets = {ws for ws, _ in live}
        self.cursors = {ws: cursor for ws, cursor in self.cursors.items() if ws in live_sockets}
        self.bounds = {ws: bound for ws, bound in self.bounds.items() if ws in live_sockets}
        for key in list(self.sent):
            if key[0] not in live_sockets:
                self.sent.pop(key)
        if not live:
            return 0
        start = self.offset % len(live)
        chosen = (live[start:] + live[:start])[:16]
        self.offset = (start + len(chosen)) % len(live)
        sent = 0
        for ws, (channel, user_id, connection_id) in chosen:
            cursor = self.cursors.get(ws, "")
            frames, repairs = [], []
            # One pooled DB session at a time; never retain it across network sends.
            async with self.sessions() as db:
                if channel.startswith("_agent_"):
                    scope = (Delivery.agent_user_id == user_id, or_(
                        Delivery.state.in_(("pending", "canceled", "uncertain")),
                        (Delivery.state == "completed") & (Delivery.lease_owner == connection_id)))
                    if not cursor:
                        self.bounds[ws] = (await db.execute(select(func.max(Delivery.delivery_id)).where(*scope))).scalar() or ""
                    rows = list((await db.execute(select(Delivery).where(
                        *scope, Delivery.delivery_id > cursor, Delivery.delivery_id <= self.bounds[ws]
                    ).order_by(Delivery.delivery_id).limit(self.batch))).scalars())
                    for row in rows:
                        task = await db.get(A2ATask, row.task_id)
                        base = {"v": 1, "task_id": row.task_id, "delivery_id": row.delivery_id,
                                "attempt": row.attempt, "origin_room": row.target_room}
                        # Revocation removes execution/data access, not the ability
                        # to stop this account's already authorized executor. No body.
                        if task and task.status == "canceled" and row.state != "cancel_ack":
                            frames.append({**base, "type": "task_cancel"})
                            continue
                        try:
                            _, source = await ds.validate_task(db, task, user_id)
                        except ds.DeliveryDenied:
                            continue
                        if row.state == "uncertain":
                            frames.append({**base, "type": "task_uncertain"})
                        elif row.state == "pending" and task.status in ACTIVE_STATUSES:
                            if not row.delivered_at or ds.aware(row.delivered_at) + timedelta(seconds=ds.LEASE_SECONDS) <= ds.now():
                                repairs.append((row.delivery_id, row.attempt))
                            else:
                                frames.append({**base, "type": "agent_task", "message_id": source.id,
                                    "content": source.content, "sender_id": source.sender_id,
                                    "sender_name": source.sender_name,
                                    "deadline": (ds.aware(row.delivered_at) + timedelta(seconds=ds.LEASE_SECONDS)).isoformat()})
                        elif row.state == "completed" and row.lease_owner == connection_id:
                            frames.append({**base, "type": "task_result_ack", "accepted": True})
                    last_id = rows[-1].delivery_id if rows else ""
                else:
                    if not cursor:
                        self.bounds[ws] = (await db.execute(select(func.max(A2ATask.id)).where(A2ATask.room_id == channel))).scalar() or ""
                    rows = list((await db.execute(select(A2ATask).where(
                        A2ATask.room_id == channel, A2ATask.id > cursor, A2ATask.id <= self.bounds[ws]
                    ).order_by(A2ATask.id).limit(self.batch))).scalars())
                    for task in rows:
                        frames.append({"type": "task_update", "task": {"id": task.id,
                            "room_id": channel, "status": task.status, "event_seq": task.event_seq}})
                        event = (await db.execute(select(TaskEvent).where(
                            TaskEvent.task_id == task.id, TaskEvent.event_type == "task_progress"
                        ).order_by(TaskEvent.event_seq.desc()).limit(1))).scalar_one_or_none()
                        if event:
                            frames.append({"v": 1, "type": "task_progress", "task_id": task.id,
                                "event_seq": event.event_seq, **{k: event.payload[k] for k in ("phase", "percent") if k in (event.payload or {})}})
                    last_id = rows[-1].id if rows else ""
            # UUID pagination is scoped to ONE pass, not a commit high-water mark.
            self.cursors[ws] = last_id if len(rows) == self.batch else ""
            for did, attempt in repairs:
                try:
                    frame = await self._repair_offer(did, attempt)
                    if frame:
                        frames.append(frame)
                except ds.DeliveryDenied:
                    continue
            for frame in frames:
                key = (ws, frame.get("delivery_id") or frame.get("task_id") or frame.get("task", {}).get("id"), frame["type"])
                previous = self.sent.get(key)
                stamp = asyncio.get_running_loop().time()
                # Repeat pending/control frames at a bounded rate until durable ACK.
                retry = frame["type"] in {"agent_task", "task_cancel"}
                if previous and previous[0] == frame and (not retry or stamp - previous[1] < 2):
                    continue
                if await self.manager.send_checked(ws, frame):
                    sent += 1
                    self.sent[key] = (frame, stamp)
                    self.sent.move_to_end(key)
                    while len(self.sent) > 4096:
                        self.sent.popitem(last=False)
        return sent
