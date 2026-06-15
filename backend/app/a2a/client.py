from __future__ import annotations
"""A2A HTTP client — calls remote agents via JSON-RPC."""

import uuid
import httpx


class A2AClient:
    """JSON-RPC client for a remote A2A agent."""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.http = httpx.AsyncClient(timeout=60)

    async def get_agent_card(self) -> dict | None:
        """Fetch the remote agent's capability declaration."""
        try:
            resp = await self.http.get(
                f"{self.base_url}/a2a/.well-known/agent-card"
            )
            resp.raise_for_status()
            return resp.json()
        except Exception:
            return None

    async def send_task(
        self, query: str, task_id: str | None = None
    ) -> dict:
        """Send a task to the remote agent via JSON-RPC."""
        tid = task_id or str(uuid.uuid4())
        payload = {
            "jsonrpc": "2.0",
            "method": "tasks/send",
            "params": {"id": tid, "query": query},
            "id": tid,
        }
        try:
            resp = await self.http.post(f"{self.base_url}/a2a", json=payload)
            result = resp.json()
            return result.get("result", {"id": tid, "status": "failed"})
        except Exception as e:
            return {"id": tid, "status": "failed", "error": str(e)}

    async def get_task(self, task_id: str) -> dict | None:
        """Check the status of a previously submitted task."""
        payload = {
            "jsonrpc": "2.0",
            "method": "tasks/get",
            "params": {"id": task_id},
            "id": task_id,
        }
        try:
            resp = await self.http.post(f"{self.base_url}/a2a", json=payload)
            result = resp.json()
            return result.get("result")
        except Exception:
            return None

    async def close(self):
        await self.http.aclose()


class A2AClientPool:
    """Pool of A2A clients, cached by agent name."""

    def __init__(self):
        self._clients: dict[str, A2AClient] = {}

    def get(self, name: str, url: str) -> A2AClient:
        if name not in self._clients:
            self._clients[name] = A2AClient(url)
        return self._clients[name]

    async def close_all(self):
        for client in self._clients.values():
            await client.close()
        self._clients.clear()
