"""Automated tests for Group D: Production configuration, database migration, readiness checks, and release safety."""

import asyncio
import os
import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
import yaml

from app.config import INSECURE_SECRET_BLACKLIST, Settings
from app.core.database import (
    CRITICAL_TABLES,
    EXPECTED_ALEMBIC_HEAD,
    check_database_readiness,
)
from tests.conftest import override_get_db

ROOT = Path(__file__).resolve().parents[2]


# =====================================================================
# 1. Production Secret Validation & Blacklist Rejection (Tasks 1 & 2)
# =====================================================================

def test_production_secret_validation_rejects_empty_and_whitespace():
    """Verify secrets with leading/trailing whitespace or empty strings are rejected in production."""
    with pytest.raises(ValueError, match="leading or trailing whitespace"):
        Settings(
            environment="production",
            auth_secret_key="",
        )

    with pytest.raises(ValueError, match="leading or trailing whitespace"):
        Settings(
            environment="production",
            auth_secret_key="  a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6  ",
        )

    with pytest.raises(ValueError, match="leading or trailing whitespace"):
        Settings(
            environment="production",
            auth_secret_key="a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6 ",
        )


def test_production_secret_validation_rejects_short_secrets():
    """Verify secrets shorter than 32 characters are rejected in production."""
    with pytest.raises(ValueError, match=">=32 chars"):
        Settings(
            environment="production",
            auth_secret_key="too-short-secret-key-123",
        )


@pytest.mark.parametrize("placeholder", sorted(list(INSECURE_SECRET_BLACKLIST)))
def test_production_secret_validation_rejects_all_blacklisted_placeholders(placeholder):
    """Verify all known default/insecure placeholders are rejected in production.

    Short placeholders are caught by the length rule; long ones by the blacklist rule.
    Either way, no blacklisted value may ever be accepted.
    """
    with pytest.raises(ValueError):
        Settings(
            environment="production",
            auth_secret_key=placeholder,
        )


def test_production_secret_validation_blacklist_message_for_long_placeholder():
    """A placeholder long enough to clear the length rule must be rejected by the blacklist."""
    placeholder = "replace-with-openssl-rand-hex-32-in-production"
    assert len(placeholder) >= 32
    with pytest.raises(ValueError, match="cannot use known insecure placeholder"):
        Settings(
            environment="production",
            auth_secret_key=placeholder,
        )


def test_production_secret_validation_rejects_low_entropy():
    """Verify secrets with low character entropy (fewer than 4 unique chars) are rejected."""
    # 32 identical chars (1 unique char)
    with pytest.raises(ValueError, match="insufficient character entropy"):
        Settings(
            environment="production",
            auth_secret_key="a" * 32,
        )

    # 2 unique chars
    with pytest.raises(ValueError, match="insufficient character entropy"):
        Settings(
            environment="production",
            auth_secret_key="ab" * 16,
        )

    # 3 unique chars
    with pytest.raises(ValueError, match="insufficient character entropy"):
        Settings(
            environment="production",
            auth_secret_key="abcabcabcabcabcabcabcabcabcabcab",
        )


def test_production_secret_validation_accepts_valid_secrets():
    """Verify cryptographically strong secret keys are accepted in production."""
    valid_key = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
    settings = Settings(
        environment="production",
        auth_secret_key=valid_key,
    )
    assert settings.auth_secret_key == valid_key


def test_development_environment_allows_dev_secrets():
    """Verify development and test environments permit development placeholders."""
    for env in ("development", "dev", "test", "testing"):
        settings = Settings(
            environment=env,
            auth_secret_key="dev-change-me",
        )
        assert settings.auth_secret_key == "dev-change-me"


# =====================================================================
# 2. Trusted Proxies Configuration Interface (Task 6)
# =====================================================================

def test_trusted_proxies_default_configuration():
    """Verify default trusted proxy list includes loopback and RFC 1918 private subnets."""
    settings = Settings(environment="development")
    expected_defaults = ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
    assert settings.trusted_proxies == expected_defaults


def test_trusted_proxies_comma_separated_parsing():
    """Verify comma-delimited string parsing into a list of proxy CIDRs."""
    settings = Settings(
        environment="development",
        trusted_proxies="127.0.0.1, 10.10.0.0/16, 192.168.1.1",  # type: ignore[arg-type]
    )
    assert settings.trusted_proxies == ["127.0.0.1", "10.10.0.0/16", "192.168.1.1"]


def test_trusted_proxies_json_array_parsing():
    """Verify JSON array string parsing into a list of proxy CIDRs."""
    settings = Settings(
        environment="development",
        trusted_proxies='["127.0.0.1", "172.20.0.0/16", "::1"]',  # type: ignore[arg-type]
    )
    assert settings.trusted_proxies == ["127.0.0.1", "172.20.0.0/16", "::1"]


def test_trusted_proxies_empty_string_parsing():
    """Verify empty string or whitespace-only proxy input produces empty list."""
    settings = Settings(
        environment="development",
        trusted_proxies="   ",  # type: ignore[arg-type]
    )
    assert settings.trusted_proxies == []


# =====================================================================
# 3. Decoupled Health (Liveness) & Readiness Probes (Task 3)
# =====================================================================

@pytest.mark.asyncio
async def test_health_liveness_probe_is_lightweight_in_memory(client: AsyncClient):
    """Liveness probe /health must return HTTP 200 without issuing database queries."""
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["service"] == "Multi-Agent Project Room"
    assert "database" not in data


@pytest.mark.asyncio
async def test_readiness_probe_success(client: AsyncClient):
    """Readiness probe /ready returns HTTP 200 when database connectivity and schema are valid."""
    resp = await client.get("/ready")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ready"
    assert data["database"] == "connected"
    assert data["revision"] == EXPECTED_ALEMBIC_HEAD


@pytest.mark.asyncio
async def test_readiness_probe_missing_alembic_version_does_not_abort_transaction():
    """A missing ``alembic_version`` on PostgreSQL must not leave the session's
    transaction aborted, so the probe still reaches the critical-table check.

    Regression test for the missing rollback in ``check_database_readiness``:
    on PostgreSQL a failed statement aborts the whole transaction, and every
    later statement on that session fails with "current transaction is aborted,
    commands ignored until end of transaction block". Without the rollback the
    probe reported a misleading ``DATABASE_UNAVAILABLE``/503 instead of the
    intended dev/test fallback that then verifies ``CRITICAL_TABLES``.

    This cannot be reproduced on SQLite, which does not abort the transaction on
    a failed statement -- which is why the default ``create_all()`` test path
    never caught it.
    """
    from sqlalchemy import text

    from conftest import engine as test_engine, test_session

    if test_engine.dialect.name != "postgresql":
        pytest.skip(
            "aborted-transaction semantics are PostgreSQL-specific; SQLite cannot "
            "reproduce the failure mode this test guards against"
        )

    # Save and remove alembic_version so the probe takes its fallback branch.
    saved_revision: str | None = None
    async with test_engine.begin() as conn:
        present = (
            await conn.execute(text("SELECT to_regclass('public.alembic_version')"))
        ).scalar()
        if present is not None:
            saved_revision = (
                await conn.execute(text("SELECT version_num FROM alembic_version"))
            ).scalar()
            await conn.execute(text("DROP TABLE alembic_version"))

    try:
        async with test_session() as session:
            result = await check_database_readiness(session=session)
        # The probe must complete on a usable transaction: not an aborted one.
        assert result["status"] == "ready", result
        assert result.get("code") is None, result
        assert result["reason"] is None, result
    finally:
        if saved_revision is not None:
            async with test_engine.begin() as conn:
                await conn.execute(
                    text(
                        "CREATE TABLE IF NOT EXISTS alembic_version ("
                        "version_num VARCHAR(32) NOT NULL, "
                        "CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))"
                    )
                )
                await conn.execute(
                    text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                    {"v": saved_revision},
                )


@pytest.mark.asyncio
async def test_readiness_probe_database_unavailable_returns_503(client: AsyncClient):
    """Readiness probe /ready returns HTTP 503 when database connectivity fails."""
    mock_db = AsyncMock()
    mock_db.execute.side_effect = asyncio.TimeoutError("Connection timed out")

    async def failing_db():
        yield mock_db

    from app.core.database import get_db
    from app.main import app

    app.dependency_overrides[get_db] = failing_db
    try:
        resp = await client.get("/ready")
        assert resp.status_code == 503
        data = resp.json()
        assert data["status"] == "not ready"
        assert data["database"] == "unavailable"
        assert "Database readiness check failed" in data.get("reason", "")
    finally:
        app.dependency_overrides[get_db] = override_get_db


@pytest.mark.asyncio
async def test_check_database_readiness_revision_mismatch():
    """check_database_readiness returns not_ready when alembic_version revision does not match expected head."""
    mock_sess = AsyncMock()
    mock_result_1 = MagicMock()
    mock_result_rev = MagicMock()
    mock_result_rev.first.return_value = ("old_rev_20260101",)

    # First call: SELECT 1
    # Second call: SELECT version_num FROM alembic_version
    mock_sess.execute.side_effect = [mock_result_1, mock_result_rev]

    res = await check_database_readiness(mock_sess)
    assert res["status"] == "not_ready"
    assert "Alembic migration revision mismatch" in res["reason"]
    assert "old_rev_20260101" in res["reason"]
    assert EXPECTED_ALEMBIC_HEAD in res["reason"]


@pytest.mark.asyncio
async def test_check_database_readiness_missing_critical_table():
    """check_database_readiness returns not_ready when a critical table is missing."""
    mock_sess = AsyncMock()
    mock_result_1 = MagicMock()
    mock_result_rev = MagicMock()
    mock_result_rev.first.return_value = (EXPECTED_ALEMBIC_HEAD,)

    # First call: SELECT 1
    # Second call: SELECT version_num
    # Third call: SELECT 1 FROM users (fails with table not found)
    mock_sess.execute.side_effect = [
        mock_result_1,
        mock_result_rev,
        Exception('relation "users" does not exist'),
    ]

    res = await check_database_readiness(mock_sess)
    assert res["status"] == "not_ready"
    assert "Database readiness check failed" in res["reason"]


# =====================================================================
# 4. Release Workflow Manual Approval Gate (Task 5)
# =====================================================================

def test_deploy_workflow_requires_manual_approval():
    """Verify .github/workflows/deploy.yml requires workflow_dispatch with inputs.deploy == true."""
    deploy_yaml_path = ROOT / ".github/workflows/deploy.yml"
    assert deploy_yaml_path.exists()
    content = deploy_yaml_path.read_text()
    data = yaml.safe_load(content)

    deploy_job = data["jobs"]["deploy"]
    condition = deploy_job.get("if", "")

    # The condition must require workflow_dispatch and inputs.deploy
    assert "github.event_name == 'workflow_dispatch'" in condition
    assert "inputs.deploy" in condition
    # Must NOT automatically trigger on push to main
    assert "refs/heads/main" not in condition
    assert "github.ref == 'refs/heads/main'" not in condition


# =====================================================================
# 5. Docker Compose Healthcheck and Dependency Synchronization (Task 3)
# =====================================================================

def test_docker_compose_backend_healthcheck_and_frontend_dependency():
    """Verify docker-compose.yml configures backend healthcheck on /ready and frontend depends_on condition."""
    compose_path = ROOT / "docker-compose.yml"
    assert compose_path.exists()
    content = compose_path.read_text()
    data = yaml.safe_load(content)

    backend = data["services"]["backend"]
    frontend = data["services"]["frontend"]

    assert "healthcheck" in backend
    healthcheck = backend["healthcheck"]
    test_cmd = " ".join(healthcheck["test"]) if isinstance(healthcheck["test"], list) else healthcheck["test"]
    assert "http://127.0.0.1:8000/ready" in test_cmd

    assert "depends_on" in frontend
    assert "backend" in frontend["depends_on"]
    assert frontend["depends_on"]["backend"]["condition"] == "service_healthy"
