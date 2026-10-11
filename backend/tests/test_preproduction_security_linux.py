"""Production boundary regressions with synthetic credential/body sentinels."""
import pytest
from httpx import ASGITransport, AsyncClient
from fastapi import FastAPI
from app.main import app, global_exception_handler, SafeHTTPErrorBoundary
from app.core import database

SENTINEL = 'synthetic-token-and-private-body-never-disclose'


@pytest.mark.asyncio
async def test_unhandled_error_response_does_not_disclose_exception():
    isolated = FastAPI()
    isolated.add_exception_handler(Exception, global_exception_handler)
    @isolated.get('/failure')
    async def fail():
        raise RuntimeError(SENTINEL)
    async with AsyncClient(transport=ASGITransport(app=isolated, raise_app_exceptions=False), base_url='http://test') as client:
        response = await client.get('/failure')
    assert response.status_code == 500
    assert SENTINEL not in response.text
    assert response.json() == {'error': 'Internal server error'}


@pytest.mark.asyncio
async def test_public_database_health_does_not_disclose_dsn(monkeypatch, client):
    def unavailable():
        raise RuntimeError(SENTINEL)
    monkeypatch.setattr(database, 'async_session', unavailable)
    response = await client.get('/health/details')
    assert SENTINEL not in response.text
    assert response.json()['database'] == {'status': 'error', 'reason': 'Database unavailable'}


@pytest.mark.asyncio
async def test_cors_uses_configured_origin_allowlist(client):
    for origin, allowed in [('http://localhost:5173', True), ('https://untrusted.invalid', False)]:
        response = await client.options('/health', headers={'Origin': origin, 'Access-Control-Request-Method': 'GET'})
        assert ('access-control-allow-origin' in response.headers) is allowed
        if allowed:
            assert response.headers['access-control-allow-origin'] == origin


@pytest.mark.asyncio
async def test_dialogue_internal_failure_does_not_disclose_body(client, auth_headers, monkeypatch):
    from app.a2a import server
    async def fail(params):
        raise ValueError(SENTINEL)
    monkeypatch.setitem(server.DIALOGUE_METHODS, 'synthetic/failure', fail)
    response = await client.post('/a2a/dialogue-rpc', headers=auth_headers, json={
        'jsonrpc': '2.0', 'id': 1, 'method': 'synthetic/failure', 'params': {}})
    assert response.json()['error']['message'] == 'Dialogue unavailable'
    assert SENTINEL not in response.text


@pytest.mark.asyncio
async def test_error_boundary_prevents_private_server_tracebacks(caplog):
    isolated = FastAPI()
    isolated.add_middleware(SafeHTTPErrorBoundary)
    @isolated.get('/failure')
    async def fail():
        raise RuntimeError(SENTINEL)
    # raise_app_exceptions=True verifies the original exception cannot escape
    # to uvicorn's error logger, beyond checking the public JSON body.
    async with AsyncClient(transport=ASGITransport(app=isolated, raise_app_exceptions=True), base_url='http://test') as client:
        response = await client.get('/failure')
    assert response.status_code == 500
    assert SENTINEL not in response.text + caplog.text
    assert 'exception details suppressed' in caplog.text
