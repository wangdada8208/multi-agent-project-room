"""Tests for MAPR Audit Round 4 Group A: Production Safety & Observability.

Covers:
1. Redis test isolation (no shared namespace wipes, dedicated test DB).
2. Log redaction (Bearer tokens, passwords, DB credentials, private keys, message bodies).
3. Database readiness probe (/ready safe error codes, no raw SQLAlchemy exceptions).
4. Metrics bounded memory (sliding window, high cardinality protection).
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import sys
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import redis
from httpx import ASGITransport, AsyncClient
from sqlalchemy.exc import OperationalError, ProgrammingError

from app.auth import rate_limit
from app.auth.rate_limit import (
    _attempts,
    _blocked_until,
    _flush_redis_state,
    _get_effective_redis_url,
    _is_test_environment,
)
from app.core import database
from app.core.database import check_database_readiness
from app.core.observability import (
    Metrics,
    RedactingFilter,
    _deep_scrub,
    install_redacting_filter,
    metrics,
    redact,
    scrub_text,
)
from app.main import app


# ---------------------------------------------------------------------------
# 1. Redis Test Isolation Tests
# ---------------------------------------------------------------------------

class TestRedisIsolation:
    """Verifies that rate limit resets do not destroy production or shared data."""

    def test_attempts_clear_does_not_flush_redis(self):
        """_attempts.clear() must only clear in-memory state, NOT flush Redis."""
        client = redis.Redis.from_url(_get_effective_redis_url(), decode_responses=True)
        test_key = "mapr:ratelimit:attempts:login:ip:192.0.2.1"
        client.set(test_key, "1")

        try:
            assert client.exists(test_key) == 1
            # Clearing fallback in-memory dict must NOT touch Redis
            _attempts.clear()
            _blocked_until.clear()
            assert client.exists(test_key) == 1
        finally:
            client.delete(test_key)

    def test_redis_flush_preserves_other_namespaces_and_hubs(self):
        """_flush_redis_state() must only delete keys matching _KEY_PREFIX, never other data."""
        client = redis.Redis.from_url(_get_effective_redis_url(), decode_responses=True)
        other_keys = [
            "other_hub:ratelimit:ip:10.0.0.1",
            "prod:ratelimit:user_alpha",
            "custom_service:session:xyz789",
        ]
        target_key = f"{rate_limit._KEY_PREFIX}attempts:test_isolated_account"

        for k in other_keys:
            client.set(k, "persisted_value")
        client.set(target_key, "temp_value")

        try:
            _flush_redis_state()

            # The rate_limit target key should be removed
            assert client.exists(target_key) == 0

            # ALL other keys from other hubs / services must remain completely untouched
            for k in other_keys:
                assert client.exists(k) == 1
                assert client.get(k) == "persisted_value"
        finally:
            for k in other_keys:
                client.delete(k)
            client.delete(target_key)

    def test_redis_test_environment_uses_dedicated_database(self):
        """Test environment must automatically target test database (e.g. DB 15)."""
        assert _is_test_environment() is True
        effective_url = _get_effective_redis_url()
        # Verify it does not target default DB 0 in test mode
        assert not effective_url.endswith("/0")
        assert "/15" in effective_url or "test" in effective_url

    def test_redis_flush_refuses_outside_test_environment(self, monkeypatch):
        """In a production environment, _flush_redis_state must refuse to scan/delete."""
        monkeypatch.setattr(rate_limit, "_is_test_environment", lambda: False)
        monkeypatch.delenv("MAPR_ALLOW_REDIS_FLUSH", raising=False)

        client = redis.Redis.from_url(_get_effective_redis_url(), decode_responses=True)
        target_key = f"{rate_limit._KEY_PREFIX}attempts:production_user"
        client.set(target_key, "prod_data")

        try:
            _flush_redis_state()
            # Must NOT be deleted because it is outside test environment
            assert client.exists(target_key) == 1
        finally:
            client.delete(target_key)


# ---------------------------------------------------------------------------
# 2. Log Redaction Tests
# ---------------------------------------------------------------------------

class TestLogRedaction:
    """Verifies that sensitive data never enters log outputs across handlers and loggers."""

    @pytest.fixture
    def log_capture(self):
        """Provide an isolated logger with a memory stream handler."""
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s:%(message)s"))
        logger = logging.getLogger(f"test_logger_{os.urandom(4).hex()}")
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)
        install_redacting_filter(logger)
        return logger, stream

    def test_logger_output_redacts_bearer_token(self, log_capture):
        logger, stream = log_capture
        logger.info("User request headers: Authorization: Bearer eyJhbGciOiJIUzI1NiI.secret_token_12345")
        output = stream.getvalue()
        assert "secret_token_12345" not in output
        assert "Bearer ***REDACTED***" in output

    def test_logger_output_redacts_passwords(self, log_capture):
        logger, stream = log_capture
        logger.info("Authentication attempt with password=SuperSecretPassword123")
        logger.info("Secondary check password: 'QuotedSecretPassword456'")
        output = stream.getvalue()
        assert "SuperSecretPassword123" not in output
        assert "QuotedSecretPassword456" not in output
        assert "password=***REDACTED***" in output

    def test_logger_output_redacts_database_credentials(self, log_capture):
        logger, stream = log_capture
        logger.info("Connecting to postgresql://admin:prod_db_secret_pass@10.0.0.1:5432/mapr_prod")
        logger.info("Cache connecting to redis://:redis_secret_pass@10.0.0.2:6379/0")
        output = stream.getvalue()
        assert "prod_db_secret_pass" not in output
        assert "redis_secret_pass" not in output
        assert "postgresql://***REDACTED***@10.0.0.1:5432/mapr_prod" in output
        assert "redis://***REDACTED***@10.0.0.2:6379/0" in output

    def test_logger_output_redacts_private_keys(self, log_capture):
        logger, stream = log_capture
        rsa_key = (
            "-----BEGIN RSA PRIVATE KEY-----\n"
            "MIIEowIBAAKCAQEA0Y1+VERY_SECRET_KEY_BODY_XYZ\n"
            "-----END RSA PRIVATE KEY-----"
        )
        ec_key = (
            "-----BEGIN EC PRIVATE KEY-----\n"
            "MHQCAQEEISECRET_EC_KEY_CONTENT_123\n"
            "-----END EC PRIVATE KEY-----"
        )
        logger.info("Loaded host key:\n%s", rsa_key)
        logger.info("Loaded client key:\n%s", ec_key)
        output = stream.getvalue()
        assert "VERY_SECRET_KEY_BODY_XYZ" not in output
        assert "SECRET_EC_KEY_CONTENT_123" not in output
        assert "***REDACTED***" in output

    def test_logger_output_redacts_message_body_and_content(self, log_capture):
        logger, stream = log_capture
        logger.info("ChatMessage received", extra={"body": "Private message text body", "content": "Secret chat message"})
        logger.info("Event payload: %s", {"author": "alice", "content": "Confidential meeting notes"})
        output = stream.getvalue()
        assert "Private message text body" not in output
        assert "Secret chat message" not in output
        assert "Confidential meeting notes" not in output

    def test_logger_covers_fastapi_and_uvicorn_paths(self):
        """Verifies that FastAPI, Uvicorn, and app loggers have RedactingFilter attached."""
        install_redacting_filter()
        for name in ("fastapi", "uvicorn", "uvicorn.access", "uvicorn.error", "app"):
            log = logging.getLogger(name)
            assert any(isinstance(f, RedactingFilter) for f in log.filters)

    def test_logger_exception_traceback_sanitization(self, log_capture):
        logger, stream = log_capture
        try:
            raise OperationalError(
                "SELECT 1",
                {},
                Exception("password authentication failed for user 'mapr' at postgresql://mapr:leak_password_here@db:5432/mapr"),
            )
        except Exception:
            logger.exception("Database query crashed")

        output = stream.getvalue()
        assert "leak_password_here" not in output
        assert "postgresql://***REDACTED***@db:5432/mapr" in output

    # -- Audit round 4, H1: bare tokens in URLs reach uvicorn's access log -----

    @staticmethod
    def _access_log(logger, stream, method, path, status=200):
        """Emit one uvicorn.access-shaped record and return just its rendered text."""
        stream.seek(0)
        stream.truncate()
        logger.info(
            '%s - "%s %s HTTP/%s" %d',
            "127.0.0.1:5000", method, path, "1.1", status,
        )
        return stream.getvalue()

    def test_access_log_invite_token_in_path_is_redacted(self, log_capture):
        """H1: `GET /api/v1/invites/<token>` must never appear verbatim in a log."""
        logger, stream = log_capture
        token = "inv_abcSECRET123"
        output = self._access_log(logger, stream, "GET", f"/api/v1/invites/{token}")
        assert token not in output
        assert output.strip(), "record must still reach the sink (not dropped)"
        # Hiding the token must not hide the incident: method, route and status
        # are exactly what an operator needs when reading an access log.
        for part in ("GET", "/api/v1/invites/", "200"):
            assert part in output, f"access log lost its diagnostic context: {part!r}"

    def test_access_log_invite_token_in_query_is_redacted(self, log_capture):
        """H1: `?token=` / `?access_token=` values must be masked as well."""
        logger, stream = log_capture
        first = self._access_log(
            logger, stream, "GET", "/api/v1/invites/detail?token=inv_QWSECRET&x=1"
        )
        second = self._access_log(
            logger, stream, "POST", "/api/v1/invites/redeem?access_token=QW7SECRET"
        )
        for token in ("inv_QWSECRET", "QW7SECRET"):
            assert token not in first + second
        assert "REDACTED" in first and "REDACTED" in second

    def test_share_credential_in_real_route_is_redacted(self):
        """The real share data route carries its credential in the path.

        ``GET /api/v1/rooms/shared/<token>/messages`` (``backend/app/api/rooms.py``,
        router prefix ``/api/v1/rooms``). Missing this rule meant the share link
        credential went to the access log verbatim.
        """
        real = scrub_text("/api/v1/rooms/shared/SHTOKENREAL/messages")
        assert "SHTOKENREAL" not in real
        assert "/api/v1/rooms/shared/" in real

        alias = scrub_text("/api/v1/shared/SHTOKENALIAS/messages")
        assert "SHTOKENALIAS" not in alias

        revoke = scrub_text("/api/v1/rooms/room-abc/share/SHTOKENREVOKE")
        assert "SHTOKENREVOKE" not in revoke
        assert "/api/v1/rooms/room-abc/share/" in revoke

        # Neighbouring routes keep their identifiers: no over-redaction.
        for path in (
            "/api/v1/rooms/room-abc-123/share-list",
            "/api/v1/rooms/room-abc/xmtp-binding",
        ):
            assert scrub_text(path) == path

    def test_plain_paths_are_not_over_redacted(self, log_capture):
        """The URL rules are anchored: ordinary routes keep their identifiers."""
        logger, stream = log_capture
        output = self._access_log(
            logger, stream, "GET", "/api/v1/rooms/room-abc123/messages?limit=20"
        )
        assert "/api/v1/rooms/room-abc123/messages" in output
        assert "limit=20" in output

    def test_hub_log_has_no_chat_body(self, log_capture):
        """XMTP execution doc, stage 1: the spoken sentence must never reach Hub logs.

        Two-way assertion on purpose:
        * the chat body and the invite credential never appear in the log text;
        * the log is not empty — "nothing was logged" must not pass as "clean".
        """
        logger, _stream = log_capture
        body = "bác sĩ hẹn thứ sáu, mang theo kết quả xét nghiệm"
        invite = "inv_abcSECRET123"
        captured: list[str] = []

        def emit(message, *args):
            """Log one record into its own fresh stream.

            StringIO keeps bytes past the new write position when a shorter line
            overwrites a longer one, so a shared stream would mix records up and
            hide (or fake) a leak.
            """
            sink = io.StringIO()
            handler = logging.StreamHandler(sink)
            handler.setFormatter(logging.Formatter("%(message)s"))
            logger.addHandler(handler)
            try:
                logger.info(message, *args)
            finally:
                logger.removeHandler(handler)
            captured.append(sink.getvalue())

        # What the Hub really emits on a chat connection: room/user short ids only.
        emit("ws connected room=%s user=%s", "abcd1234", "user5678")
        # Delivery bookkeeping: body must never be an argument to a log call.
        emit("delivered message=%s room=%s", "msg-1", "abcd1234")
        # Access log for the same room chat, plus the invite lookup.
        emit('%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "GET",
             "/ws/chat/room-abc123?token=WsTokSECRET", "1.1", 200)
        emit('%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "GET",
             f"/api/v1/invites/{invite}", "1.1", 200)

        output = "".join(captured)
        assert output.strip(), "no log output captured: the test would pass vacuously"
        assert all(part.strip() for part in captured), "a record was dropped entirely"
        assert body not in output, "chat body leaked into the Hub log"
        assert invite not in output, "invite token leaked into the Hub log"
        assert "WsTokSECRET" not in output, "access token leaked into the Hub log"
        # Operational context still present, so the log is usable for debugging.
        assert "ws connected room=abcd1234" in output
        assert "delivered message=msg-1" in output

    def test_third_party_logger_with_own_handler_is_redacted(self):
        """A library that assigns its own handler must not bypass redaction.

        Regression for the probe the tester ran: ``log.handlers = [h]`` never
        touches ``Logger.addHandler``, so a handler-level filter is skipped and
        the invite token reached the sink verbatim.
        """
        install_redacting_filter()
        token = "inv_LEAKCHECK777"
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter("%(message)s"))

        logger = logging.getLogger(f"httpx_test_{os.urandom(4).hex()}")
        logger.setLevel(logging.DEBUG)
        logger.propagate = False
        # Direct assignment: deliberately skips the addHandler hook.
        logger.handlers = [handler]

        logger.info(
            'HTTP Request: %s %s "%s %d %s"',
            "GET", f"http://127.0.0.1:8913/api/v1/invites/{token}", "HTTP/1.1", 404, "Not Found",
        )
        output = stream.getvalue()
        assert token not in output, "token leaked through a third-party logger handler"
        assert "HTTP Request" in output, "record must still be emitted"
        assert "404" in output, "status must survive for diagnostics"

    def test_nested_args_are_scrubbed_recursively(self):
        """SQLAlchemy logs bound params as a nested tuple: scrub every level."""
        import secrets

        token = secrets.token_urlsafe(32)
        scrubbed = _deep_scrub(("generated in 0.0004s", (token,)))
        assert token not in repr(scrubbed)
        assert "generated in 0.0004s" in repr(scrubbed), "timing must survive"

    def test_partial_args_are_scrubbed(self):
        """aiosqlite logs a functools.partial whose bound args hold the params."""
        import functools
        import secrets

        token = secrets.token_urlsafe(32)

        def fake_execute(sql, params):
            return None

        value = functools.partial(fake_execute, "select * from t where token=?", (token,))
        rendered = repr(_deep_scrub(value))
        assert token not in rendered
        assert "functools.partial(" in rendered

    def test_opaque_param_wrapper_is_scrubbed(self):
        """SQLAlchemy passes ``_repr_params``, not a tuple: unwrap its payload.

        This is the exact shape the real service leaked: a wrapper object whose
        ``repr`` prints the values, so an ``isinstance(tuple)`` check misses it.
        """
        import secrets

        token = secrets.token_urlsafe(32)

        class ReprParams:
            """Stand-in with the same shape as sqlalchemy.sql.util._repr_params."""

            def __init__(self, params):
                self.params = params

            def __repr__(self):
                return repr(self.params)

        scrubbed = repr(_deep_scrub(ReprParams((token,))))
        assert token not in scrubbed
        assert "ReprParams(" in scrubbed, "wrapper must stay recognisable in logs"

    def test_real_sqlalchemy_params_do_not_leak_into_log(self):
        """End-to-end: a real SQLAlchemy engine's DEBUG log must not print the token."""
        import io
        import secrets

        token = secrets.token_urlsafe(32)
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter("%(message)s"))
        engine_logger = logging.getLogger("sqlalchemy.engine.Engine")
        old_level = engine_logger.level
        engine_logger.addHandler(handler)
        engine_logger.setLevel(logging.DEBUG)
        engine_logger.propagate = False
        install_redacting_filter()
        try:
            from sqlalchemy import create_engine, text

            engine = create_engine("sqlite://")
            with engine.begin() as conn:
                conn.execute(text("select 1 where :t = :t"), {"t": token})
            engine.dispose()
        finally:
            engine_logger.removeHandler(handler)
            engine_logger.setLevel(old_level)

        output = stream.getvalue()
        assert output.strip(), "no SQLAlchemy log captured: the test would pass vacuously"
        assert token not in output, "bound parameter leaked into the SQLAlchemy log"

    def test_eager_logger_names_are_covered(self):
        install_redacting_filter()
        for name in (
            "httpx", "httpcore", "sqlalchemy", "sqlalchemy.engine",
            "sqlalchemy.engine.Engine", "sqlalchemy.pool",
            "websockets", "websockets.client", "websockets.server",
        ):
            log = logging.getLogger(name)
            assert any(isinstance(f, RedactingFilter) for f in log.filters), name

    def test_m1_format_args_never_reinject_secret(self, log_capture):
        """M1: scrubbing the template must not drop the record or echo raw args."""
        logger, _stream = log_capture
        token = "eyJhbGciOiJIUzI1NiI.secret_token_12345"
        outputs = []
        for message, args in (
            ("Authorization: Bearer %s", (token,)),
            ("ws connected room=%s user=%s", ("room-a1b2c3d4", "user-uuid-5678")),
            ("invite ?token=%s verified", ("inv_SECRET9",)),
        ):
            # A fresh stream per record: StringIO keeps stale bytes past the new
            # write position when a shorter line overwrites a longer one.
            extra = io.StringIO()
            handler = logging.StreamHandler(extra)
            handler.setFormatter(logging.Formatter("%(message)s"))
            logger.addHandler(handler)
            try:
                logger.info(message, *args)
            finally:
                logger.removeHandler(handler)
            outputs.append(extra.getvalue())
        combined = "".join(outputs)
        assert token not in combined
        # Secrets that reached the log through args or through the template must
        # never come back out: not re-injected, not echoed by an exception.
        assert "inv_SECRET9" not in combined
        # A template that carries no secret keeps rendering normally: room and
        # user short ids are operational context, not credentials.
        assert "ws connected room=room-a1b2c3d4" in combined
        # All three records reached the sink: none was dropped by a TypeError.
        assert all(line.strip() for line in outputs)
        # All three records reached the sink: none was dropped by a TypeError.
        assert all(line.strip() for line in outputs)


# ---------------------------------------------------------------------------
# 3. Database Readiness Probe Tests
# ---------------------------------------------------------------------------

class TestDatabaseReadinessProbe:
    """Verifies that /ready and check_database_readiness return clean, safe codes."""

    @pytest.mark.asyncio
    async def test_ready_operational_error_returns_clean_code(self):
        """When database connection fails, /ready must return 503 with safe code."""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            fake_exc = OperationalError(
                "SELECT 1",
                {},
                Exception("connection to server at postgresql://user:secretpass@127.0.0.1:5432 failed: Connection refused"),
            )
            with patch("app.gateway.routes.check_database_readiness", new_callable=AsyncMock) as mock_check:
                mock_check.return_value = {
                    "status": "not_ready",
                    "code": "DATABASE_CONNECTION_ERROR",
                    "reason": "Database readiness check failed: Database connection failed",
                    "diagnostic": "OperationalError: Connection refused",
                }

                resp = await client.get("/ready")
                assert resp.status_code == 503
                data = resp.json()
                assert data["status"] == "not ready"
                assert data["code"] == "DATABASE_CONNECTION_ERROR"
                assert "Database connection failed" in data["reason"]
                assert "secretpass" not in str(data)
                assert "SELECT 1" not in str(data)

    @pytest.mark.asyncio
    async def test_check_database_readiness_masks_sqlalchemy_raw_exception(self):
        """Direct check_database_readiness must redact raw exceptions."""
        session_mock = AsyncMock()
        session_mock.execute.side_effect = OperationalError(
            "SELECT 1",
            {},
            Exception("FATAL: password authentication failed for user 'mapr' at postgresql://mapr:mysecretpwd@db:5432/mapr"),
        )

        result = await check_database_readiness(session=session_mock)
        assert result["status"] == "not_ready"
        assert result["code"] == "DATABASE_CONNECTION_ERROR"
        assert "mysecretpwd" not in result["reason"]
        assert "mysecretpwd" not in result["diagnostic"]
        assert "postgresql://***REDACTED***@db:5432/mapr" in result["diagnostic"]

    @pytest.mark.asyncio
    async def test_ready_preserves_alembic_head_and_schema_validation(self):
        """Schema check must still detect version mismatches and missing tables."""
        session_mock = AsyncMock()
        # SELECT 1 succeeds
        # Alembic version returns wrong head
        rev_mock = MagicMock()
        rev_mock.scalar_one_or_none.return_value = "outdated_rev_001"
        session_mock.execute.return_value = rev_mock

        result = await check_database_readiness(session=session_mock)
        assert result["status"] == "not_ready"
        assert "revision mismatch" in result["reason"]


# ---------------------------------------------------------------------------
# 4. Metrics Bounded Memory Tests
# ---------------------------------------------------------------------------

class TestMetricsMemoryBounds:
    """Verifies that Metrics observe() and label cardinality are strictly bounded."""

    def test_metrics_observe_sliding_window_bound(self):
        """Timing observations must not exceed max_samples_per_timing."""
        bounded_metrics = Metrics(max_samples_per_timing=100, max_series=100)
        for i in range(1000):
            bounded_metrics.observe("request_duration", float(i) / 1000.0)

        key = ("request_duration", ())
        assert len(bounded_metrics._timings[key]) == 100
        # The window must contain only the most recent 100 samples (900..999)
        assert list(bounded_metrics._timings[key])[-1] == 0.999
        assert list(bounded_metrics._timings[key])[0] == 0.900

    def test_metrics_high_cardinality_series_eviction(self):
        """High cardinality labels must be bounded by max_series to avoid OOM."""
        bounded_metrics = Metrics(max_samples_per_timing=10, max_series=50)

        for i in range(500):
            bounded_metrics.observe("api_latency", 0.05, user_id=f"user_{i}")

        # Number of unique series must not exceed max_series
        assert len(bounded_metrics._timings) <= 50

        # Snapshot should operate normally without failure
        snap = bounded_metrics.snapshot()
        assert len(snap["timings"]) <= 50

    def test_metrics_counters_and_gauges_high_cardinality_bound(self):
        """Counters and gauges must also be bounded by max_series."""
        bounded_metrics = Metrics(max_series=50)

        for i in range(300):
            bounded_metrics.increment("http_requests_total", 1, path=f"/items/{i}")
            bounded_metrics.gauge("active_connections", float(i), host=f"host_{i}")

        assert len(bounded_metrics._counters) <= 50
        assert len(bounded_metrics._gauges) <= 50

    def test_metrics_long_term_high_frequency_memory_stability(self):
        """Long-term high-frequency recording must maintain constant bounded memory."""
        bounded_metrics = Metrics(max_samples_per_timing=50, max_series=50)

        # Record 50,000 observations rapidly
        for i in range(50000):
            bounded_metrics.observe("high_frequency_op", 0.012, op_id=str(i % 100))

        # Series count is bounded
        assert len(bounded_metrics._timings) <= 50
        for samples in bounded_metrics._timings.values():
            assert len(samples) <= 50

        snap = bounded_metrics.snapshot()
        assert len(snap["timings"]) <= 50