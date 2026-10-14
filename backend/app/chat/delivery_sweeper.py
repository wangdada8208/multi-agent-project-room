"""Bounded lease housekeeping. SQL state is shared; notifications are process-local."""
import asyncio
import logging
from sqlalchemy import select
from app.a2a.models import A2ATask
from app.a2a.task_service import ACTIVE_STATUSES
from app.chat.delivery_service import expire_delivery, now, slug
from app.core.observability import metrics
from app.models.agent_task_delivery import AgentTaskDelivery as Delivery
from app.models.user import User
from app.ws.connection_manager import connection_manager

logger = logging.getLogger(__name__)
BATCH_SIZE = 50


class DeliverySweeper:
    def __init__(self, session_factory, interval=10.0, pass_timeout=5.0):
        if interval <= 0 or pass_timeout <= 0:
            raise ValueError("Positive sweeper timings required")
        self.session_factory = session_factory
        self.interval = interval
        self.pass_timeout = pass_timeout
        self.task = None

    async def run_once(self, limit=BATCH_SIZE):
        if type(limit) is not int or not 1 <= limit <= BATCH_SIZE:
            raise ValueError("Invalid sweep batch limit")
        stamp = now()
        async with self.session_factory() as db:
            ids = (await db.execute(select(Delivery.delivery_id).join(A2ATask).where(
                Delivery.state == "acked", Delivery.lease_until <= stamp,
                A2ATask.status.in_(ACTIVE_STATUSES),
            ).order_by(Delivery.lease_until, Delivery.task_id).limit(limit))).scalars().all()
        changed = 0
        for delivery_id in ids:
            async with self.session_factory() as db:
                frame = await expire_delivery(db, delivery_id, stamp)
                channel = None
                if frame:
                    delivery = await db.get(Delivery, delivery_id)
                    agent = await db.get(User, delivery.agent_user_id)
                    if agent and agent.user_type == "agent":
                        channel = "_agent_" + slug(agent.username)
                await db.commit()
            if frame:
                changed += 1
                if channel:
                    # Only after commit. Missing broadcast does not undo durable fencing.
                    try:
                        await connection_manager.broadcast(channel, frame)
                    except Exception:
                        logger.warning("Lease notification unavailable")
        metrics.increment("delivery_sweeper.expired", value=changed)
        return changed

    def start(self):
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run(), name="delivery-lease-sweeper")
        return self.task

    async def _run(self):
        while True:
            try:
                await asyncio.wait_for(self.run_once(), self.pass_timeout)
            except asyncio.CancelledError:
                raise
            except Exception:
                # Do not log DB exceptions, URLs, connection strings or task content.
                metrics.increment("delivery_sweeper.failures")
                logger.warning("Lease scan failed or timed out; will retry")
            await asyncio.sleep(self.interval)

    async def stop(self):
        task, self.task = self.task, None
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
