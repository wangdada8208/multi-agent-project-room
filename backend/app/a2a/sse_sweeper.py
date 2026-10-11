"""Bounded SSE lease expiry housekeeping; no credentials or SQL in logs."""
import asyncio
import logging
from app.a2a.sse_global_quota import SSEGlobalQuota

logger = logging.getLogger(__name__)


class SSEQuotaSweeper:
    def __init__(self, sessions, interval=10.0):
        self.sessions = sessions
        self.interval = interval
        self.policy = SSEGlobalQuota()
        self.task = None

    async def run_once(self):
        async with self.sessions() as db:
            return await self.policy.sweep(db)

    def start(self):
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run(), name='sse-quota-sweeper')

    async def _run(self):
        while True:
            try:
                await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning('SSE quota sweep unavailable; will retry')
            await asyncio.sleep(self.interval)

    async def stop(self):
        task, self.task = self.task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
