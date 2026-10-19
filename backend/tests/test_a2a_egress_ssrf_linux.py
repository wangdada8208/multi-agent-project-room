"""End-to-end egress policy tests with real validation and mocked HTTP transport."""

import json
import socket
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from sqlalchemy import select

from app.a2a import server
from app.a2a.client import A2AClient, A2AClientPool
from app.core.security import create_access_token
from app.models.agent_card import AgentCardRecord
from app.models.user import User
from conftest import fake_agent_dns


OPERATIONS = ["dialogue", "card", "send", "status"]
BAD_URLS = [
    "http://127.0.0.1:8000", "http://10.0.0.1", "http://169.254.169.254",
    "http://[::ffff:127.0.0.1]", "http://0x7f000001",
    "http://user:synthetic-sensitive-value@agent.example:443",
    "http://agent.example:invalid", "file:///synthetic-sensitive-value",
]


@pytest.fixture
def network(monkeypatch):
    # Default policy remains enabled, with synthetic DNS and zero real HTTP.
    monkeypatch.delenv("MAPR_A2A_ALLOW_LOCALHOST", raising=False)
    monkeypatch.delenv("MAPR_A2A_LOCAL_ALLOWLIST", raising=False)
    monkeypatch.delenv("MAPR_SSRF_ALLOWLIST", raising=False)
    state = SimpleNamespace(requests=[], clients=[], dns=[], ip="93.184.215.14", redirect=False)

    # Only the synthetic agent hostnames are faked; the test database and Redis
    # resolve through the real resolver. Faking every host hijacked the
    # PostgreSQL lookup in CI (where the DSN host is "localhost") and killed the
    # SSRF gates with a 60s asyncpg TimeoutError.
    dns = fake_agent_dns(lambda: state.ip, record=state.dns.append)

    async def send(transport, request):
        state.requests.append(request)
        if state.redirect:
            return httpx.Response(302, headers={"Location": "http://127.0.0.1/private"}, json={})
        return httpx.Response(200, json={"name": "Agent", "skills": [{"id": "review"}],
                                        "result": {"id": "task-1", "status": "completed",
                                                   "artifacts": [{"parts": ["safe reply"]}]}})

    original_init = httpx.AsyncClient.__init__
    def client_init(self, *args, **kwargs):
        state.clients.append(kwargs)
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", dns)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", send)
    monkeypatch.setattr(httpx.AsyncClient, "__init__", client_init)
    return state


async def call(operation, url, monkeypatch):
    if operation == "dialogue":
        monkeypatch.setattr(server.AgentDiscovery, "list_available", AsyncMock(
            return_value=[{"name": "codex", "url": url}]))
        return await server._send_to_agent("codex", "review this")
    remote = A2AClient(url)
    try:
        if operation == "card":
            return await remote.get_agent_card()
        if operation == "send":
            return await remote.send_task("review this", task_id="task-1")
        return await remote.get_task("task-1")
    finally:
        await remote.close()


async def agent_headers(db):
    user = User(username="codex", display_name="Friendly", user_type="agent")
    db.add(user)
    await db.commit()
    return {"Authorization": f"Bearer {create_access_token(user.id, 'agent')}"}


@pytest.mark.asyncio
@pytest.mark.parametrize("url", BAD_URLS + ["local://someone_else"])
@pytest.mark.parametrize("existing", [False, True])
async def test_rest_authorized_agent_rejects_bad_url_without_db_change(client, db, network, url, existing):
    headers = await agent_headers(db)
    if existing:
        db.add(AgentCardRecord(agent_name="codex", agent_card_url="local://codex",
                               capabilities=["original"], is_active=True))
        await db.commit()
    response = await client.post("/api/v1/agents/register", headers=headers,
                                 json={"name": "Codex", "url": url, "capabilities": ["changed"]})
    assert response.status_code in (400, 403)
    assert "synthetic-sensitive-value" not in response.text
    assert url not in response.text
    assert network.requests == []
    rows = (await db.execute(select(AgentCardRecord))).scalars().all()
    assert len(rows) == int(existing)
    if existing:
        assert rows[0].agent_card_url == "local://codex"
        assert rows[0].capabilities == ["original"]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("url", BAD_URLS)
async def test_legacy_bad_url_never_reaches_http(operation, url, monkeypatch, network, caplog):
    result = await call(operation, url, monkeypatch)
    assert network.requests == []
    assert "synthetic-sensitive-value" not in str(result) + caplog.text
    if operation in ("card", "status"):
        assert result is None
    elif operation == "send":
        assert result["status"] == "failed"
    else:
        assert "无法连接" in result


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", OPERATIONS)
async def test_public_egress_pins_ip_and_preserves_protocol(operation, monkeypatch, network):
    result = await call(operation, "https://agent.example:8443/base", monkeypatch)
    assert len(network.requests) == 1
    request = network.requests[0]
    assert request.url.host == "93.184.215.14"
    assert request.url.port == 8443
    assert request.headers["Host"] == "agent.example:8443"
    assert request.extensions["sni_hostname"] == "agent.example"
    assert len(network.dns) == 1
    assert network.clients[-1]["trust_env"] is False
    assert network.clients[-1]["follow_redirects"] is False
    assert request.extensions["timeout"]["connect"] <= 5
    assert request.extensions["timeout"]["read"] == (5 if operation == "card" else 60)
    expected_suffix = "/.well-known/agent-card.json" if operation == "card" else "/a2a/rpc"
    assert request.url.path == "/base" + expected_suffix
    if operation == "card":
        assert request.method == "GET"
        assert result["skills"] == [{"id": "review"}]
    else:
        assert request.method == "POST"
        body = json.loads(request.content)
        assert body["jsonrpc"] == "2.0"
        if operation == "dialogue":
            assert body["method"] == "SendMessage"
            assert request.headers["A2A-Version"] == "1.0"
            params = body["params"]
            assert params["configuration"] == {"returnImmediately": False}
            assert params["message"]["role"] == "ROLE_USER"
            assert params["message"]["parts"] == [{"text": "review this"}]
            assert params["message"]["messageId"] == body["id"]
            assert result == "safe reply"
        elif operation == "send":
            assert request.headers["A2A-Version"] == "1.0"
            assert body["method"] == "SendMessage"
            assert body["params"] == {"message": {"messageId": "task-1", "role": "ROLE_USER",
                                                  "parts": [{"text": "review this"}], "metadata": {}},
                                      "configuration": {"returnImmediately": True}}
            assert body["id"] == "task-1"
            assert result["status"] == "completed"
        else:
            assert request.headers["A2A-Version"] == "1.0"
            assert body["method"] == "GetTask"
            assert body["params"] == {"id": "task-1"}
            assert result["id"] == "task-1"


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", OPERATIONS)
async def test_redirects_and_proxy_environment_do_not_send_to_internal(operation, monkeypatch, network):
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        monkeypatch.setenv(key, "http://127.0.0.1:8888")
    network.redirect = True
    await call(operation, "https://agent.example", monkeypatch)
    assert len(network.requests) == 1
    assert network.requests[0].url.host == "93.184.215.14"
    assert network.clients[-1]["trust_env"] is False
    assert network.clients[-1]["follow_redirects"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", OPERATIONS)
async def test_every_outbound_request_revalidates_dns(operation, monkeypatch, network):
    await call(operation, "https://agent.example", monkeypatch)
    assert len(network.requests) == 1
    network.ip = "127.0.0.1"
    await call(operation, "https://agent.example", monkeypatch)
    assert len(network.requests) == 1
    assert len(network.dns) == 2


@pytest.mark.asyncio
async def test_same_client_revalidates_dns_and_pool_uses_changed_url(monkeypatch, network):
    pool = A2AClientPool()
    first = pool.get("codex", "https://agent.example")
    try:
        await first.send_task("one")
        network.ip = "10.0.0.1"
        await first.get_task("task-1")
        assert len(network.requests) == 1
        updated = pool.get("codex", "https://new-agent.example")
        assert updated.base_url == "https://new-agent.example"
        network.ip = "93.184.215.14"
        await updated.get_agent_card()
        assert network.requests[-1].headers["Host"] == "new-agent.example"
    finally:
        await pool.close_all()


@pytest.mark.asyncio
@pytest.mark.parametrize("url", ["", "local://codex"])
async def test_rest_local_registration_stays_local(client, db, network, monkeypatch, url):
    headers = await agent_headers(db)
    response = await client.post("/api/v1/agents/register", headers=headers, json={"name": "Codex", "url": url})
    assert response.status_code == 200
    assert response.json()["agent"]["url"] == "local://codex"
    for operation in OPERATIONS:
        await call(operation, "local://codex", monkeypatch)
    assert network.requests == []
    assert network.dns == []


@pytest.mark.asyncio
async def test_rest_public_registration_validates_without_probing(client, db, network):
    headers = await agent_headers(db)
    response = await client.post("/api/v1/agents/register", headers=headers,
                                 json={"name": "Codex", "url": "https://agent.example"})
    assert response.status_code == 200
    assert len(network.dns) == 1
    assert network.requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", OPERATIONS)
async def test_default_http_transport_connects_to_pin_with_verified_tls(operation, monkeypatch):
    """Keep HTTPX/httpcore real; replace only DNS and the TCP/TLS stream."""
    import ssl
    from httpcore._backends.auto import AutoBackend
    from httpcore._backends.base import AsyncNetworkStream

    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        monkeypatch.setenv(key, "http://127.0.0.1:8888")
    connections, tls, writes, dns_calls = [], [], [], []
    body = json.dumps({"skills": [], "result": {"status": "completed", "artifacts": []}}).encode()

    class Stream(AsyncNetworkStream):
        def __init__(self):
            self.response = (b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                             + str(len(body)).encode() + b"\r\n\r\n" + body)

        async def read(self, max_bytes, timeout=None):
            response, self.response = self.response[:max_bytes], self.response[max_bytes:]
            return response

        async def write(self, buffer, timeout=None):
            writes.append(buffer)

        async def aclose(self):
            pass

        async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
            tls.append((server_hostname, ssl_context.check_hostname, ssl_context.verify_mode, timeout))
            return self

    async def connect(backend, host, port, timeout=None, **kwargs):
        connections.append((host, port, timeout))
        return Stream()

    # Same scoping rule: agent.example is faked, infrastructure hosts are real.
    dns = fake_agent_dns("93.184.215.14", record=dns_calls.append)

    monkeypatch.setattr(socket, "getaddrinfo", dns)
    monkeypatch.setattr(AutoBackend, "connect_tcp", connect)
    await call(operation, "https://agent.example:8443", monkeypatch)
    assert connections == [("93.184.215.14", 8443, 5.0)]
    assert tls == [("agent.example", True, ssl.CERT_REQUIRED, 5.0)]
    assert dns_calls == ["agent.example"]
    assert b"Host: agent.example:8443\r\n" in b"".join(writes)
