"""Agent enrollment regressions; only synthetic users and mocked transport."""

from types import SimpleNamespace
from unittest.mock import AsyncMock
import asyncio

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.auth import routes, rate_limit
from app.config import Settings
from app.core.security import hash_password
from app.models.user import User
from local_agent_adapter import LocalAgentAdapter


@pytest.fixture(autouse=True)
def isolated_auth(monkeypatch):
    rate_limit._attempts.clear()
    rate_limit._blocked_until.clear()
    monkeypatch.setattr(routes, "get_settings", lambda: SimpleNamespace(
        agent_enrollment_secret=SecretStr("test-enrollment-secret")), raising=False)


def payload(username="CoDeX", user_type="agent"):
    return dict(username=username, password="secret123", display_name="Friendly", user_type=user_type)


@pytest.mark.asyncio
@pytest.mark.parametrize("configured,key", [
    ("", None), ("", "test-enrollment-secret"),
    ("test-enrollment-secret", None), ("test-enrollment-secret", "wrong-key"),
    ("test-enrollment-secret", "é-wrong-key"),
])
async def test_enrollment_denied_without_explicit_matching_secret(client, db, monkeypatch, caplog, configured, key):
    monkeypatch.setattr(routes, "get_settings", lambda: SimpleNamespace(agent_enrollment_secret=SecretStr(configured)))
    # Latin-1 HTTP header is deliberately tested without relying on UTF-8 header encoding.
    headers = {} if key is None else {b"X-Agent-Enrollment-Key": key.encode("latin-1")}
    response = await client.post("/api/v1/auth/register", json=payload(), headers=headers)
    assert response.status_code == 403
    assert not (await db.execute(select(User))).scalars().all()
    assert "test-enrollment-secret" not in response.text + caplog.text
    assert "wrong-key" not in response.text + caplog.text


def test_production_enrollment_default_is_empty_and_redacted(monkeypatch):
    monkeypatch.delenv("MAPR_AGENT_ENROLLMENT_SECRET", raising=False)
    settings = Settings(_env_file=None)
    assert settings.agent_enrollment_secret.get_secret_value() == ""
    assert "synthetic-secret" not in repr(Settings(_env_file=None, agent_enrollment_secret="synthetic-secret"))


@pytest.mark.asyncio
async def test_matching_enrollment_key_and_human_registration(client, db):
    response = await client.post("/api/v1/auth/register", json=payload(),
                                 headers={"X-Agent-Enrollment-Key": "test-enrollment-secret"})
    assert response.status_code == 200
    assert response.json()["user"]["username"] == "codex"
    assert (await db.execute(select(User))).scalar_one().username == "codex"
    human = await client.post("/api/v1/auth/register", json=payload("Alice", "human"))
    assert human.status_code == 200
    assert human.json()["user"]["user_type"] == "human"


@pytest.mark.asyncio
async def test_human_name_cannot_become_agent(client, db):
    db.add(User(username="CoDeX", display_name="Human", user_type="human"))
    await db.commit()
    response = await client.post("/api/v1/auth/register", json=payload("codex"),
                                 headers={"X-Agent-Enrollment-Key": "test-enrollment-secret"})
    assert response.status_code == 409
    assert (await db.execute(select(User))).scalar_one().user_type == "human"


@pytest.mark.asyncio
async def test_new_accounts_share_canonical_unique_namespace(client):
    human = await client.post("/api/v1/auth/register", json=payload("Alice", "human"))
    assert human.status_code == 200
    assert human.json()["user"]["username"] == "alice"
    response = await client.post("/api/v1/auth/register", json=payload("ALICE"),
                                 headers={"X-Agent-Enrollment-Key": "test-enrollment-secret"})
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_concurrent_case_variants_use_database_uniqueness(client, db):
    responses = await asyncio.gather(*[
        client.post("/api/v1/auth/register", json=payload(name),
                    headers={"X-Agent-Enrollment-Key": "test-enrollment-secret"})
        for name in ("Codex", "CODEX")
    ])
    assert sorted(response.status_code for response in responses) == [200, 409]
    assert (await db.execute(select(User))).scalar_one().username == "codex"


@pytest.mark.asyncio
async def test_enrollment_uses_constant_time_comparison(client, monkeypatch):
    from unittest.mock import Mock
    import hmac
    compare = Mock(wraps=hmac.compare_digest)
    monkeypatch.setattr(routes.hmac, "compare_digest", compare)
    response = await client.post("/api/v1/auth/register", json=payload(),
                                 headers={"X-Agent-Enrollment-Key": "wrong-key"})
    assert response.status_code == 403
    compare.assert_called_once_with(b"wrong-key", b"test-enrollment-secret")


@pytest.mark.asyncio
async def test_legacy_agent_login_casefold_variants_resolve_to_one_account(client, db):
    """单行场景：大小写变体都能登录到同一个旧账号。"""
    db.add(User(username="CoDeX", display_name="Legacy", user_type="agent", password_hash=hash_password("secret123")))
    await db.commit()
    for name in ("codex", "CoDeX", "CODEX"):
        response = await client.post("/api/v1/auth/login", json=dict(username=name, password="secret123"))
        assert response.status_code == 200, response.text


@pytest.mark.asyncio
async def test_duplicate_comparison_identity_is_refused_by_db_and_login(client, db, monkeypatch):
    """迁移 i90 之前 `CoDeX` 与 `codex` 能在同一个库里共存，之后不可能。

    所以分两层验证，而不是继续制造一个迁移后不可能出现的数据状态：
    1. 数据库不变量：第二行同比较键的账号必须被唯一约束拒绝；
    2. 登录路径的歧义处理：万一匹配到两条（历史库 / 恢复的备份），
       登录必须 401，绝不能任选一个账号放行。
    改用例是语义正确的，不是为了让 CI 变绿。
    """
    db.add(User(username="CoDeX", display_name="Legacy", user_type="agent", password_hash=hash_password("secret123")))
    await db.commit()

    # 1) 数据库不变量：第二行落不下去
    db.add(User(username="codex", display_name="Other owner", user_type="human",
                password_hash=hash_password("different123")))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    # 2) 歧义分支：把两条匹配记录直接交给登录路径
    stored = (await db.execute(select(User))).scalars().one()

    async def two_matches(_db, _username):
        return [stored, stored]

    # app.auth.routes 在导入时把 find_username_matches 绑进了自己的命名空间，
    # 因此要 patch routes 上的那一个。
    monkeypatch.setattr(routes, "find_username_matches", two_matches)

    for name in ("codex", "CoDeX", "CODEX"):
        response = await client.post("/api/v1/auth/login", json=dict(username=name, password="secret123"))
        assert response.status_code == 401, f"{name!r} 命中两条匹配时必须 401，实际 {response.status_code}"


@pytest.mark.asyncio
async def test_registration_unique_failure_rolls_back(client, db, monkeypatch):
    from app.core.database import get_db
    from app.main import app
    original = app.dependency_overrides[get_db]
    async def override():
        yield db
    app.dependency_overrides[get_db] = override
    rollback = AsyncMock(wraps=db.rollback)
    monkeypatch.setattr(db, "rollback", rollback)
    monkeypatch.setattr(db, "commit", AsyncMock(side_effect=IntegrityError("insert", {}, Exception("synthetic unique"))))
    try:
        response = await client.post("/api/v1/auth/register", json=payload(),
                                     headers={"X-Agent-Enrollment-Key": "test-enrollment-secret"})
        assert response.status_code == 409
        rollback.assert_awaited_once()
        assert "synthetic unique" not in response.text
        assert not (await db.execute(select(User))).scalars().all()
    finally:
        app.dependency_overrides[get_db] = original


@pytest.mark.asyncio
@pytest.mark.parametrize("key,raises", [(None, False), ("synthetic-client-key", False), ("synthetic-client-key", True)])
async def test_adapter_enrollment_environment_only_and_no_secret_output(monkeypatch, capsys, key, raises):
    monkeypatch.delenv("MAPR_AGENT_ENROLLMENT_KEY", raising=False)
    if key:
        monkeypatch.setenv("MAPR_AGENT_ENROLLMENT_KEY", key)
    adapter = LocalAgentAdapter(server="http://test", room="room", agent_name="Codex", agent_id="codex",
                                command=["codex"], a2a_port=8765, ai_timeout=10,
                                auth_username="codex", auth_password="secret123", auth_register=True)
    calls = []
    async def post(path, **kwargs):
        calls.append((path, kwargs))
        if path.endswith("login"):
            return httpx.Response(401)
        if raises:
            raise RuntimeError("transport included synthetic-client-key")
        return httpx.Response(200, json={"access_token": "synthetic-token"})
    monkeypatch.setattr(adapter.http, "post", post)
    try:
        await adapter._authenticate()
        registration = [kwargs for path, kwargs in calls if path.endswith("register")]
        if key:
            assert registration[0]["headers"] == {"X-Agent-Enrollment-Key": key}
            assert adapter.authenticated is (not raises)
        else:
            assert not registration
        output = capsys.readouterr().out
        assert "synthetic-client-key" not in output
        assert "synthetic-token" not in output
        if not key or raises:
            assert "administrator" in output.lower()
    finally:
        await adapter.http.aclose()


@pytest.mark.asyncio
async def test_adapter_existing_agent_login_does_not_require_enrollment_key(monkeypatch):
    monkeypatch.delenv("MAPR_AGENT_ENROLLMENT_KEY", raising=False)
    adapter = LocalAgentAdapter(server="http://test", room="room", agent_name="Codex", agent_id="codex",
                                command=["codex"], a2a_port=8765, ai_timeout=10,
                                auth_username="CoDeX", auth_password="secret123", auth_register=True)
    post = AsyncMock(return_value=httpx.Response(200, json={"access_token": "synthetic-token"}))
    monkeypatch.setattr(adapter.http, "post", post)
    try:
        await adapter._authenticate()
        post.assert_awaited_once_with("/api/v1/auth/login", json={"username": "CoDeX", "password": "secret123"})
        assert adapter.authenticated
        assert adapter.http.headers["Authorization"] == "Bearer synthetic-token"
    finally:
        await adapter.http.aclose()
