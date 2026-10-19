"""SSRF regression and defense tests for AgentDiscovery.

All outbound network requests must be blocked before socket creation
for loopback, private, link-local, cloud metadata, multicast, reserved,
IPv6-mapped IPv4, obfuscated IP formats, userinfo, non-HTTP(S) schemes,
and unverified DNS resolution.
"""

import os
import socket
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from sqlalchemy import select

from app.a2a.discovery import AgentDiscovery
from app.a2a.url_policy import (
    SSRFValidationError,
    build_pinned_request,
    safe_agent_http_request,
    validate_agent_card_url,
)
from app.models.agent_card import AgentCardRecord
from conftest import protect_infrastructure_hosts


# ── Synthetic Test Matrix for Register ─────────────────────────────────────────

DISALLOWED_REGISTER_URLS = [
    # Loopback IPv4
    "http://127.0.0.1:8000",
    "http://127.0.1.1",
    # Cloud metadata
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.169.253",
    "http://metadata.google.internal",
    "http://100.100.100.200",
    # Non-HTTP(S) schemes
    "file:///etc/passwd",
    "ftp://example.com/card.json",
    "gopher://127.0.0.1:70/",
    # Default localhost without allowlist
    "http://localhost:8000",
    "http://localhost.localdomain",
    # IPv6 loopback & private / link-local / ULA
    "http://[::1]:8000",
    "http://[::ffff:127.0.0.1]:8000",
    "http://[fe80::1]:8000",
    "http://[fc00::1]:8000",
    "http://[fd00::1]:8000",
    # Obfuscated IPv4 formats
    "http://2130706433",          # decimal 127.0.0.1
    "http://0177.0.0.1",          # octal 127.0.0.1
    "http://0x7f000001",          # hex 127.0.0.1
    "http://0x7f.1",              # hex/decimal 127.0.0.1
    "http://127.1",               # shortened 127.0.0.1
    "http://0xa9fea9fe",          # hex 169.254.169.254
    "http://2852039166",          # decimal 169.254.169.254
    "http://0.0.0.0:8000",        # unspecified
    # RFC 1918 Private networks
    "http://10.0.0.1:8080",
    "http://172.16.0.1:8080",
    "http://192.168.1.1:8080",
    # Carrier Grade NAT
    "http://100.64.0.1:8080",
    # Userinfo in URL
    "http://admin:secretpassword@example.com:8000",
]


@pytest.mark.asyncio
@pytest.mark.parametrize("malicious_url", DISALLOWED_REGISTER_URLS)
async def test_register_rejects_disallowed_urls_before_outbound_request(db, malicious_url):
    """Register must fail-closed on any disallowed URL before sending outbound request."""
    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        with pytest.raises(ValueError) as exc_info:
            await AgentDiscovery.register("MaliciousAgent", malicious_url)

        # Outbound HTTP GET must NEVER be called
        mock_get.assert_not_called()
        # Secret/password must not leak into exception message
        assert "secretpassword" not in str(exc_info.value)

    # Must NOT have written to database
    stmt = select(AgentCardRecord).where(AgentCardRecord.agent_name == "MaliciousAgent")
    records = (await db.execute(stmt)).scalars().all()
    assert len(records) == 0


@pytest.mark.asyncio
async def test_register_rejects_dns_resolving_to_private_ip(db):
    """Hostnames that resolve to private or loopback IPs must be rejected."""
    # Synthetic DNS returning private IP
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", port or 80))
        ]

    with patch("socket.getaddrinfo", side_effect=protect_infrastructure_hosts(fake_getaddrinfo)):
        with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
            with pytest.raises(ValueError):
                await AgentDiscovery.register("PrivateDNSAgent", "http://agent.internal.corp")
            mock_get.assert_not_called()


@pytest.mark.asyncio
async def test_register_rejects_mixed_dns_records(db):
    """If DNS resolution returns multiple IPs and any is private (DNS rebinding), reject."""
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", port or 80)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port or 80)),
        ]

    with patch("socket.getaddrinfo", side_effect=protect_infrastructure_hosts(fake_getaddrinfo)):
        with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
            with pytest.raises(ValueError):
                await AgentDiscovery.register("MixedDNSAgent", "http://rebind.attacker.com")
            mock_get.assert_not_called()


@pytest.mark.asyncio
async def test_health_check_marks_legacy_malicious_urls_offline_without_probing(db):
    """Health check must re-validate URLs from DB and mark offline without probing."""
    # Insert legacy malicious record directly in DB
    malicious_record = AgentCardRecord(
        agent_name="LegacyEvil",
        agent_card_url="http://169.254.169.254/latest/meta-data/",
        capabilities=[],
        skills=[],
        is_active=True,
    )
    db.add(malicious_record)
    await db.commit()

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        result = await AgentDiscovery.health_check()
        mock_get.assert_not_called()

    # The record should now be marked offline (is_active == False)
    await db.refresh(malicious_record)
    assert malicious_record.is_active is False
    assert result["offline"] >= 1


@pytest.mark.asyncio
async def test_probe_ignores_proxy_env(db, monkeypatch):
    """Environment proxies must be ignored (trust_env=False, follow_redirects=False)."""
    monkeypatch.setenv("HTTP_PROXY", "http://malicious-proxy:8080")
    monkeypatch.setenv("HTTPS_PROXY", "http://malicious-proxy:8080")
    monkeypatch.setenv("ALL_PROXY", "socks5://malicious-proxy:1080")

    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", port or 443))]

    client_instances = []
    original_init = httpx.AsyncClient.__init__

    def spying_init(self, *args, **kwargs):
        client_instances.append(kwargs)
        original_init(self, *args, **kwargs)

    class MockTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"skills": ["test"]})

    with patch("socket.getaddrinfo", side_effect=protect_infrastructure_hosts(fake_getaddrinfo)):
        with patch("app.a2a.url_policy.create_pinned_transport", return_value=MockTransport()):
            with patch.object(httpx.AsyncClient, "__init__", spying_init):
                reg = await AgentDiscovery.register("ProxyTestAgent", "https://agent.example.com/card")
                assert reg["status"] == "registered"

    assert len(client_instances) > 0
    for init_kwargs in client_instances:
        assert init_kwargs.get("trust_env") is False
        assert init_kwargs.get("follow_redirects") is False
        assert init_kwargs.get("timeout") <= 5.0


@pytest.mark.asyncio
async def test_valid_public_url_pins_verified_ip_and_sets_host_sni(db):
    """Public domain should resolve once, connect to verified IP, and preserve Host / SNI."""
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", port or 443))]

    recorded_requests = []

    class MockTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            recorded_requests.append(request)
            return httpx.Response(
                200,
                json={"name": "PublicAgent", "skills": [{"id": "search"}]},
            )

    with patch("socket.getaddrinfo", side_effect=protect_infrastructure_hosts(fake_getaddrinfo)):
        with patch("app.a2a.url_policy.create_pinned_transport", return_value=MockTransport()):
            reg = await AgentDiscovery.register("PublicAgent", "https://agent.example.com/card")
            assert reg["status"] == "registered"

    assert len(recorded_requests) > 0
    req = recorded_requests[0]
    # Request URL must connect to pinned IP
    assert "93.184.215.14" in str(req.url)
    # Host header must be original domain
    assert req.headers.get("Host") == "agent.example.com"
    # SNI extension must be original domain for TLS
    assert req.extensions.get("sni_hostname") == "agent.example.com"


@pytest.mark.asyncio
async def test_redirect_to_internal_ip_is_blocked(db):
    """Redirect to an internal network (e.g. 302 to 127.0.0.1) must not be followed."""
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", port or 80))]

    recorded_requests = []

    class MockRedirectTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            recorded_requests.append(request)
            # Returns a 302 redirect to internal IP
            return httpx.Response(
                302,
                headers={"Location": "http://127.0.0.1:8000/secret"},
            )

    with patch("socket.getaddrinfo", side_effect=protect_infrastructure_hosts(fake_getaddrinfo)):
        with patch("app.a2a.url_policy.create_pinned_transport", return_value=MockRedirectTransport()):
            # Registration proceeds without following redirect (skills remains empty)
            reg = await AgentDiscovery.register("RedirectAgent", "http://redirect.example.com")
            assert reg["status"] == "registered"

    # Only the initial request was sent; internal location was never requested
    assert len(recorded_requests) >= 1
    for req in recorded_requests:
        assert "127.0.0.1" not in str(req.url)
        assert "secret" not in str(req.url)


@pytest.mark.asyncio
async def test_localhost_allowlist_behavior(db, monkeypatch):
    """Allowlist permits configured localhost:port only, never metadata or private net."""
    # 1. Without allowlist, localhost is rejected
    monkeypatch.delenv("MAPR_A2A_ALLOW_LOCALHOST", raising=False)
    monkeypatch.delenv("MAPR_A2A_LOCAL_ALLOWLIST", raising=False)
    with pytest.raises(ValueError):
        await AgentDiscovery.register("LocalAgent", "http://localhost:9999")

    # 2. With allowlist enabled for 9999
    monkeypatch.setenv("MAPR_A2A_ALLOW_LOCALHOST", "true")
    monkeypatch.setenv("MAPR_A2A_LOCAL_ALLOWLIST", "http://localhost:9999,http://127.0.0.1:9999")

    class MockLocalTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"skills": ["local-skill"]})

    with patch("app.a2a.url_policy.create_pinned_transport", return_value=MockLocalTransport()):
        reg = await AgentDiscovery.register("LocalAgent", "http://localhost:9999")
        assert reg["status"] == "registered"

    # 3. Port 8888 is NOT allowlisted -> rejected
    with pytest.raises(ValueError):
        await AgentDiscovery.register("UnallowedPortAgent", "http://localhost:8888")

    # 4. Any attempt to put metadata IP in allowlist is strictly ignored and rejected
    monkeypatch.setenv("MAPR_A2A_LOCAL_ALLOWLIST", "http://169.254.169.254,http://10.0.0.1")
    with pytest.raises(ValueError):
        await AgentDiscovery.register("MetadataInAllowlist", "http://169.254.169.254")


@pytest.mark.asyncio
async def test_localhost_allowlist_scheme_mismatch(monkeypatch):
    """Allowlist configured with https must reject http for same host and port."""
    monkeypatch.setenv("MAPR_A2A_ALLOW_LOCALHOST", "true")
    monkeypatch.setenv("MAPR_A2A_LOCAL_ALLOWLIST", "https://localhost:9999")

    # http request should fail despite host and port matching
    with pytest.raises(ValueError):
        await AgentDiscovery.register("SchemeMismatchAgent", "http://localhost:9999")

    # https request with allowlist configured for https should succeed
    class MockLocalTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"skills": ["ssl-local"]})

    with patch("app.a2a.url_policy.create_pinned_transport", return_value=MockLocalTransport()):
        reg = await AgentDiscovery.register("HttpsLocalAgent", "https://localhost:9999")
        assert reg["status"] == "registered"


@pytest.mark.asyncio
async def test_public_domain_aaaa_ipv6_host_header_no_brackets():
    """Domain resolving to IPv6 via AAAA must not wrap domain name in Host header brackets."""
    def fake_getaddrinfo(host, port, *args, **kwargs):
        # Return a public IPv6 address
        return [
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:2800:220:1:248:1893:25c8:1946", port or 443))
        ]

    recorded_requests = []

    class MockTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            recorded_requests.append(request)
            return httpx.Response(200, json={"jsonrpc": "2.0", "result": "ok", "id": "1"})

    with patch("socket.getaddrinfo", side_effect=protect_infrastructure_hosts(fake_getaddrinfo)):
        with patch("app.a2a.url_policy.create_pinned_transport", return_value=MockTransport()):
            resp = await safe_agent_http_request(
                "https://agent.example.com",
                suffix="/a2a/rpc",
                method="POST",
                json_body={"jsonrpc": "2.0", "method": "tasks/send", "params": {}, "id": "1"},
            )
            assert resp.status_code == 200

    assert len(recorded_requests) == 1
    req = recorded_requests[0]
    # URL connects to pinned IPv6 in brackets
    assert "https://[2606:2800:220:1:248:1893:25c8:1946]/a2a/rpc" == str(req.url)
    # Host header must be domain name without brackets: Host: agent.example.com (NOT [agent.example.com])
    assert req.headers.get("Host") == "agent.example.com"
    # SNI extension must be domain name without brackets
    assert req.extensions.get("sni_hostname") == "agent.example.com"
    assert req.headers.get("content-type") == "application/json"


@pytest.mark.asyncio
async def test_safe_agent_http_request_post_json_rpc():
    """safe_agent_http_request pins public IP, transmits json body, and sets headers."""
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", port or 80))
        ]

    recorded_requests = []

    class MockTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            recorded_requests.append(request)
            return httpx.Response(200, json={"jsonrpc": "2.0", "result": {"task_id": "abc"}, "id": "42"})

    with patch("socket.getaddrinfo", side_effect=protect_infrastructure_hosts(fake_getaddrinfo)):
        with patch("app.a2a.url_policy.create_pinned_transport", return_value=MockTransport()):
            resp = await safe_agent_http_request(
                "http://rpc-agent.example.com/a2a",
                suffix="/rpc",
                method="POST",
                json_body={"jsonrpc": "2.0", "method": "message/send", "id": "42"},
                headers={"X-Custom-Auth": "test-token"},
            )
            assert resp.status_code == 200
            assert resp.json()["result"]["task_id"] == "abc"

    assert len(recorded_requests) == 1
    req = recorded_requests[0]
    assert "http://93.184.215.14/a2a/rpc" == str(req.url)
    assert req.headers.get("Host") == "rpc-agent.example.com"
    assert req.headers.get("X-Custom-Auth") == "test-token"
    assert req.headers.get("Content-Type") == "application/json"
    assert b'"message/send"' in req.content


@pytest.mark.asyncio
async def test_safe_agent_http_request_bounded_timeouts():
    """Client timeouts are clamped: connect <= 5.0s, read <= 60.0s, trust_env=False, follow_redirects=False."""
    def fake_getaddrinfo(host, port, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", port or 443))]

    client_inits = []
    original_init = httpx.AsyncClient.__init__

    def spying_init(self, *args, **kwargs):
        client_inits.append(kwargs)
        original_init(self, *args, **kwargs)

    class MockTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"ok": True})

    with patch("socket.getaddrinfo", side_effect=protect_infrastructure_hosts(fake_getaddrinfo)):
        with patch("app.a2a.url_policy.create_pinned_transport", return_value=MockTransport()):
            with patch.object(httpx.AsyncClient, "__init__", spying_init):
                # Pass excessive timeouts: connect 20s, read 120s
                await safe_agent_http_request(
                    "https://agent.example.com",
                    method="POST",
                    json_body={"ping": True},
                    timeout=100.0,
                    connect_timeout=20.0,
                    read_timeout=120.0,
                )

    assert len(client_inits) == 1
    opts = client_inits[0]
    assert opts["trust_env"] is False
    assert opts["follow_redirects"] is False
    to = opts["timeout"]
    assert isinstance(to, httpx.Timeout)
    assert to.connect <= 5.0
    assert to.read <= 60.0


@pytest.mark.asyncio
@pytest.mark.parametrize("disallowed_url", [
    "http://127.0.0.1:8000",
    "http://169.254.169.254/meta-data",
    "http://10.0.0.1/rpc",
    "http://localhost:8000/a2a",
    "file:///etc/passwd",
    "ftp://example.com/rpc",
])
async def test_safe_agent_http_request_blocks_disallowed_urls_before_outbound(disallowed_url):
    """safe_agent_http_request must reject any disallowed URL before sending any outbound request."""
    with patch("httpx.AsyncClient.request", new_callable=AsyncMock) as mock_req:
        with pytest.raises(ValueError):
            await safe_agent_http_request(disallowed_url, method="POST", json_body={"test": 1})
        mock_req.assert_not_called()

