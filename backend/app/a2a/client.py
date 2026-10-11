from __future__ import annotations
"""A2A HTTP client — calls remote agents via JSON-RPC."""

import uuid
import json
from urllib.parse import quote
from app.a2a.url_policy import safe_agent_http_stream
from app.a2a.url_policy import safe_agent_http_request


class A2AClient:
    """JSON-RPC client for a remote A2A agent."""

    def __init__(self, base_url: str, *, token: str | None = None, room_id: str | None = None, target_agent: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.headers = {"A2A-Version": "1.0", **({"Authorization": f"Bearer {token}"} if token else {})}
        self.metadata = {k:v for k,v in {"roomId":room_id,"targetAgent":target_agent}.items() if v}

    @property
    def rpc_suffix(self):
        return "" if self.base_url.endswith("/rpc") else ("/rpc" if self.base_url.endswith("/a2a") else "/a2a/rpc")

    @staticmethod
    def _legacy_task(value, fallback_id=None):
        """Retain caller-facing status strings while the wire uses proto enums."""
        if not isinstance(value, dict):
            return None
        if "message" in value:
            message = value["message"]
            return {"id": message.get("taskId") or fallback_id,
                    "status":"completed", "artifacts":[{"parts":message.get("parts", [])}]}
        task = dict(value.get("task", value))
        if isinstance(task.get("status"), dict):
            task["status"] = task["status"].get("state", "TASK_STATE_UNSPECIFIED").removeprefix("TASK_STATE_").lower()
        return task

    async def get_agent_card(self) -> dict | None:
        """Fetch the remote agent's capability declaration."""
        try:
            resp = await safe_agent_http_request(
                self.base_url.removesuffix("/a2a/rpc").removesuffix("/a2a"), "/.well-known/agent-card.json",
                connect_timeout=5.0, read_timeout=5.0,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception:
            return None

    async def send_task(
        self, query: str, task_id: str | None = None, *, return_immediately: bool = True
    ) -> dict:
        """Send a task to the remote agent via JSON-RPC."""
        tid = task_id or str(uuid.uuid4())
        payload = {
            "jsonrpc": "2.0",
            "method": "SendMessage",
            "params": {"message": {"messageId": tid, "role": "ROLE_USER",
                "parts": [{"text": query}], "metadata": self.metadata},
                "configuration": {"returnImmediately": return_immediately}},
            "id": tid,
        }
        try:
            resp = await safe_agent_http_request(
                self.base_url, self.rpc_suffix, method="POST", json_body=payload, headers=self.headers,
                connect_timeout=5.0, read_timeout=60.0,
            )
            resp.raise_for_status()
            result = resp.json()
            value = result.get("result", {"id": tid, "status": "failed"})
            return self._legacy_task(value, tid)
        except Exception:
            return {"id": tid, "status": "failed", "error": "Agent endpoint is disallowed or unavailable"}

    async def get_task(self, task_id: str) -> dict | None:
        """Check the status of a previously submitted task."""
        payload = {
            "jsonrpc": "2.0",
            "method": "GetTask",
            "params": {"id": task_id},
            "id": task_id,
        }
        try:
            resp = await safe_agent_http_request(
                self.base_url, self.rpc_suffix, method="POST", json_body=payload, headers=self.headers,
                connect_timeout=5.0, read_timeout=60.0,
            )
            resp.raise_for_status()
            result = resp.json()
            return self._legacy_task(result.get("result"), task_id)
        except Exception:
            return None

    async def cancel_task(self, task_id: str) -> dict | None:
        payload = {"jsonrpc":"2.0", "method":"CancelTask", "params":{"id":task_id}, "id":str(uuid.uuid4())}
        try:
            response = await safe_agent_http_request(self.base_url, self.rpc_suffix,
                method="POST", json_body=payload, headers=self.headers,
                connect_timeout=5.0, read_timeout=60.0)
            response.raise_for_status()
            return self._legacy_task(response.json().get("result"), task_id)
        except Exception:
            return None

    async def subscribe_task(self, task_id: str, after_seq: int = 0):
        """Yield bounded SSE frames; connection errors fail closed without URL details."""
        if after_seq < 0:
            raise ValueError("Invalid event cursor")
        base = self.base_url.removesuffix("/rpc")
        if not base.endswith("/a2a"):
            base += "/a2a"
        headers = {**self.headers, "Accept":"text/event-stream", "Last-Event-ID":str(after_seq)}
        try:
            async with safe_agent_http_stream(base, "/tasks/" + quote(task_id, safe="") + ":subscribe", headers=headers) as response:
                frame = {}
                data = []
                size = 0
                pending = b""
                async for chunk in response.aiter_bytes(chunk_size=1024):
                    pending += chunk
                    if len(pending) > 65536:
                        raise ValueError("Event too large")
                    while b"\n" in pending:
                        raw, pending = pending.split(b"\n", 1)
                        line = raw.rstrip(b"\r").decode("utf-8")
                        size += len(raw)
                        if size > 65536:
                            raise ValueError("Event too large")
                        if not line:
                            if data:
                                frame["data"] = json.loads("\n".join(data))
                                yield frame
                            frame, data, size = {}, [], 0
                        elif line.startswith("data:"):
                            data.append(line[5:].lstrip())
                        elif line.startswith("id:"):
                            frame["id"] = line[3:].strip()
                        elif line.startswith("event:"):
                            frame["event"] = line[6:].strip()

        except Exception:
            raise ValueError("Agent stream is disallowed or unavailable") from None

    async def close(self):
        """Shared safe helper owns and closes each request's HTTP client."""
        return None


class A2AClientPool:
    """Pool of A2A clients, cached by agent name."""

    def __init__(self):
        self._clients: dict[str, A2AClient] = {}

    def get(self, name: str, url: str) -> A2AClient:
        if name not in self._clients or self._clients[name].base_url != url.rstrip("/"):
            self._clients[name] = A2AClient(url)
        return self._clients[name]

    async def close_all(self):
        for client in self._clients.values():
            await client.close()
        self._clients.clear()
