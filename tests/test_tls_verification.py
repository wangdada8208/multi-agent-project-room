"""TLS verification hardening regression tests (offline, deterministic).

These tests fail against the original code (four `verify=False` sites, hardcoded
credentials) and pass after 方案 A is implemented.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import ssl
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import run_live_verification as live  # noqa: E402
import trusted_runner as tr  # noqa: E402

TRUSTED_SRC = (ROOT / "trusted_runner.py").read_text(encoding="utf-8")
LIVE_SRC = (ROOT / "run_live_verification.py").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def self_signed_pem():
    """A locally generated self-signed leaf certificate (no network access)."""
    try:
        with tempfile.TemporaryDirectory() as tmp:
            key = os.path.join(tmp, "key.pem")
            crt = os.path.join(tmp, "cert.pem")
            proc = subprocess.run(
                [
                    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", key, "-out", crt, "-days", "2",
                    "-subj", "/CN=internal.example",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=60,
            )
            if proc.returncode == 0:
                return Path(crt).read_text(encoding="ascii")
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    # Fallback: generate offline with the `cryptography` library.
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "internal.example")])
        now = datetime.now(timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=2))
            .sign(key, hashes.SHA256())
        )
        return cert.public_bytes(serialization.Encoding.PEM).decode("ascii")
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"cannot generate a local self-signed certificate: {exc}")


def _der_fingerprint(pem: str) -> str:
    return hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()


# ── 1. 默认校验开启 ────────────────────────────────────────────────

def test_default_client_enables_verification(monkeypatch):
    captured = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(tr.httpx, "AsyncClient", FakeClient)
    runner = tr.TrustedRunner(agent_name="A", server_url="https://hub.example.com")
    runner._get_client()
    assert captured.get("verify") is True
    assert runner.verify is True
    assert runner.ws_ssl is None


def test_compute_verify_default_is_explicit_true():
    assert tr.compute_verify("https://hub.example.com") is True
    assert tr.compute_verify("http://localhost:8000") is True


# ── 2. 源码里不再有关闭校验的开关 ──────────────────────────────────

def test_trusted_runner_source_has_zero_verify_false():
    assert "verify=False" not in TRUSTED_SRC


def test_all_three_httpx_sites_use_computed_verify():
    assert TRUSTED_SRC.count("verify=self.verify") == 3


def test_cli_exposes_both_tls_flags():
    assert "--tls-ca-bundle" in TRUSTED_SRC
    assert "--tls-cert-fingerprint" in TRUSTED_SRC
    assert "tls_ca_bundle=args.tls_ca_bundle" in TRUSTED_SRC
    assert "tls_cert_fingerprint=args.tls_cert_fingerprint" in TRUSTED_SRC


# ── 3. CA bundle ──────────────────────────────────────────────────

def test_ca_bundle_path_used_as_verify(monkeypatch, tmp_path, self_signed_pem):
    ca_file = tmp_path / "ca.pem"
    ca_file.write_text(self_signed_pem, encoding="ascii")
    captured = {}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(tr.httpx, "AsyncClient", FakeClient)
    runner = tr.TrustedRunner(
        agent_name="A", server_url="https://internal.example", tls_ca_bundle=str(ca_file)
    )
    runner._get_client()
    assert runner.verify == str(ca_file)
    assert captured.get("verify") == str(ca_file)
    assert isinstance(runner.ws_ssl, ssl.SSLContext)
    assert tr.ws_ssl_context(runner.verify) is not None


def test_ca_bundle_missing_path_is_rejected(tmp_path):
    missing = str(tmp_path / "does-not-exist.pem")
    with pytest.raises(FileNotFoundError, match="CA bundle"):
        tr.compute_verify("https://internal.example", tls_ca_bundle=missing)


def test_ca_bundle_and_fingerprint_are_mutually_exclusive(tmp_path):
    ca_file = tmp_path / "ca.pem"
    ca_file.write_text("x", encoding="ascii")
    with pytest.raises(ValueError, match="二选一"):
        tr.compute_verify(
            "https://internal.example",
            tls_ca_bundle=str(ca_file),
            tls_cert_fingerprint="0" * 64,
        )


# ── 4. 证书指纹固定 ────────────────────────────────────────────────

def test_fingerprint_rejects_wrong_pin(monkeypatch, self_signed_pem):
    monkeypatch.setattr(
        tr, "fetch_peer_cert_pem", lambda url, timeout=None: self_signed_pem.encode("ascii")
    )
    with pytest.raises(ValueError, match="指纹不匹配"):
        tr.compute_verify(
            "https://internal.example", tls_cert_fingerprint="0" * 64
        )


def test_fingerprint_accepts_right_pin(monkeypatch, self_signed_pem):
    monkeypatch.setattr(
        tr, "fetch_peer_cert_pem", lambda url, timeout=None: self_signed_pem.encode("ascii")
    )
    pin = _der_fingerprint(self_signed_pem)
    verify = tr.compute_verify("https://internal.example", tls_cert_fingerprint=pin)
    assert isinstance(verify, ssl.SSLContext)
    assert verify.verify_mode == ssl.CERT_REQUIRED
    assert verify.check_hostname is False
    assert len(verify.get_ca_certs()) == 1
    assert tr.ws_ssl_context(verify) is verify

    # 大小写不敏感、允许冒号分隔
    colon_pin = ":".join(pin[i : i + 2] for i in range(0, 64, 2)).upper()
    assert tr.normalise_fingerprint(colon_pin) == pin
    verify2 = tr.compute_verify(
        "https://internal.example", tls_cert_fingerprint=colon_pin
    )
    assert isinstance(verify2, ssl.SSLContext)


def test_fingerprint_rejects_malformed_pin():
    with pytest.raises(ValueError, match="SHA-256"):
        tr.normalise_fingerprint("not-a-fingerprint")
    with pytest.raises(ValueError, match="SHA-256"):
        tr.normalise_fingerprint("AB:CD")
    assert tr.normalise_fingerprint("a" * 64) == "a" * 64
    assert tr.normalise_fingerprint("A" * 64) == "a" * 64


def test_fingerprint_fetch_rejects_non_https():
    with pytest.raises(ValueError, match="https"):
        tr.fetch_peer_cert_pem("http://internal.example")


# ── 5. WebSocket 复用同一校验配置 ──────────────────────────────────

def _connect_and_run_with_stubs(monkeypatch, runner):
    http_calls, ws_calls = [], []

    class StubResponse:
        status_code = 500
        text = "stub"

        def json(self):
            return {"rooms": []}

    class StubAsyncClient:
        def __init__(self, *args, **kwargs):
            http_calls.append(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, *args, **kwargs):
            return StubResponse()

        async def get(self, *args, **kwargs):
            return StubResponse()

    class StubWS:
        async def send(self, payload):
            return None

        def __aiter__(self):
            async def empty():
                if False:  # pragma: no cover
                    yield ""

            return empty()

    class StubConnect:
        def __init__(self, url, **kwargs):
            ws_calls.append(kwargs)

        async def __aenter__(self):
            return StubWS()

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(tr.httpx, "AsyncClient", StubAsyncClient)
    monkeypatch.setattr(tr.websockets, "connect", StubConnect)
    asyncio.run(runner.connect_and_run(token="tok"))
    return http_calls, ws_calls


def test_websocket_uses_same_ssl_context(monkeypatch, tmp_path, self_signed_pem):
    ca_file = tmp_path / "ca.pem"
    ca_file.write_text(self_signed_pem, encoding="ascii")

    default_runner = tr.TrustedRunner(
        agent_name="A", server_url="https://hub.example.com", room_id="r"
    )
    _, default_ws = _connect_and_run_with_stubs(monkeypatch, default_runner)
    assert default_ws and "ssl" not in default_ws[0]  # 默认模式用系统信任库

    custom_runner = tr.TrustedRunner(
        agent_name="A",
        server_url="https://hub.example.com",
        room_id="r",
        tls_ca_bundle=str(ca_file),
    )
    http_calls, custom_ws = _connect_and_run_with_stubs(monkeypatch, custom_runner)
    assert isinstance(custom_ws[0].get("ssl"), ssl.SSLContext)
    assert custom_ws[0]["ssl"] is custom_runner.ws_ssl
    assert http_calls and all(call.get("verify") == str(ca_file) for call in http_calls)
    assert "ssl=self.ws_ssl" in TRUSTED_SRC


# ── 6. 到期计算与告警（纯函数，确定性） ──────────────────────────────

def test_days_until_expiry():
    now = datetime(2026, 11, 18, 8, 33, 20, tzinfo=timezone.utc)
    assert tr.days_until_expiry("Dec 18 08:33:20 2026 GMT", now=now) == 30
    assert tr.days_until_expiry("Dec 18 08:33:20 2026 UTC", now=now) == 30
    assert tr.days_until_expiry("Nov 19 08:33:20 2026 GMT", now=now) == 1
    assert tr.days_until_expiry("Nov 17 08:33:20 2026 GMT", now=now) == -1
    assert tr.days_until_expiry("Dec 18 08:33:19 2026 GMT", now=now) == 29


def test_expiry_warning_threshold():
    assert tr.should_warn_cert_expiry(0) is True
    assert tr.should_warn_cert_expiry(29) is True
    assert tr.should_warn_cert_expiry(30) is True
    assert tr.should_warn_cert_expiry(31) is False
    assert tr.should_warn_cert_expiry(-1) is True
    assert tr.should_warn_cert_expiry(5, warn_days=7) is True
    assert tr.should_warn_cert_expiry(8, warn_days=7) is False
    assert tr.CERT_EXPIRY_WARN_DAYS == 30


def test_expiry_warning_is_logged(monkeypatch, caplog):
    monkeypatch.setattr(
        tr, "peer_cert_not_after", lambda *a, **k: "Dec 18 08:33:20 2026 GMT"
    )
    monkeypatch.setattr(tr, "days_until_expiry", lambda *a, **k: 10)
    with caplog.at_level(logging.WARNING, logger="trusted_runner"):
        tr.warn_if_cert_expiring_soon("https://hub.example.com")
    assert any("到期" in rec.getMessage() for rec in caplog.records)


def test_expiry_warning_not_logged_when_far_away(monkeypatch, caplog):
    monkeypatch.setattr(
        tr, "peer_cert_not_after", lambda *a, **k: "Dec 18 08:33:20 2027 GMT"
    )
    monkeypatch.setattr(tr, "days_until_expiry", lambda *a, **k: 100)
    with caplog.at_level(logging.WARNING, logger="trusted_runner"):
        tr.warn_if_cert_expiring_soon("https://hub.example.com")
    assert not any("到期" in rec.getMessage() for rec in caplog.records)


def test_expiry_check_never_crashes_on_network_errors(monkeypatch):
    def boom(*args, **kwargs):
        raise OSError("network down")

    monkeypatch.setattr(tr, "peer_cert_not_after", boom)
    tr.warn_if_cert_expiring_soon("https://hub.example.com")  # 必须不抛异常


# ── 7. loopback http 默认不受影响 ───────────────────────────────────

def test_http_localhost_default_is_unaffected(monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("must not open a socket for http://localhost")

    monkeypatch.setattr(tr.socket, "create_connection", boom)
    runner = tr.TrustedRunner(agent_name="A", server_url="http://localhost:8000")
    assert runner.verify is True
    assert runner.ws_ssl is None
    assert tr.peer_cert_not_after("http://localhost:8000") is None
    tr.warn_if_cert_expiring_soon("http://localhost:8000")  # 不抛异常、不联网


# ── 8. run_live_verification.py 加固 ────────────────────────────────

def test_live_verification_source_has_no_hardcoded_credential_literal():
    assert "12345678" not in LIVE_SRC
    assert "password" not in LIVE_SRC
    assert not re.search(r'^\s*(USERNAME|PASSWORD)\s*=\s*["\']', LIVE_SRC, re.M)
    assert "MAPR_LIVE_USERNAME" in LIVE_SRC
    assert "MAPR_LIVE_PASSWORD" in LIVE_SRC


def test_live_verification_source_has_no_verify_false():
    assert "verify=False" not in LIVE_SRC
    assert "httpx.AsyncClient()" in LIVE_SRC


def test_live_verification_credentials_come_from_env(monkeypatch):
    monkeypatch.delenv("MAPR_LIVE_USERNAME", raising=False)
    monkeypatch.delenv("MAPR_LIVE_PASSWORD", raising=False)
    assert live.load_credentials() == (None, None)
    monkeypatch.setenv("MAPR_LIVE_USERNAME", "alice")
    monkeypatch.setenv("MAPR_LIVE_PASSWORD", "s3cr3t")
    assert live.load_credentials() == ("alice", "s3cr3t")


def test_live_verification_exits_cleanly_when_credentials_missing(monkeypatch, capsys):
    monkeypatch.delenv("MAPR_LIVE_USERNAME", raising=False)
    monkeypatch.delenv("MAPR_LIVE_PASSWORD", raising=False)
    assert asyncio.run(live.main()) is False
    out = capsys.readouterr().out
    assert "MAPR_LIVE_USERNAME" in out and "MAPR_LIVE_PASSWORD" in out


# ── 9. 登录失败返回体截断 ───────────────────────────────────────────

def test_truncate_error_body_helper():
    assert tr.truncate_error_body("short") == "short"
    long_body = "A" * 1000
    truncated = tr.truncate_error_body(long_body)
    assert len(truncated) <= tr.LOGIN_ERROR_BODY_LIMIT + len("...(truncated)")
    assert "truncated" in truncated
    assert "A" * 500 not in truncated
    assert tr.truncate_error_body(None) == ""


def test_login_failure_error_is_truncated(monkeypatch):
    class StubResponse:
        status_code = 401
        text = "MALICIOUS" * 100

        def json(self):
            return {}

    captured = {}

    class StubAsyncClient:
        def __init__(self, *args, **kwargs):
            captured.update(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, *args, **kwargs):
            return StubResponse()

    monkeypatch.setattr(tr.httpx, "AsyncClient", StubAsyncClient)
    runner = tr.TrustedRunner(agent_name="A", server_url="https://hub.example.com")
    with pytest.raises(ValueError) as excinfo:
        asyncio.run(
            runner.connect_and_run(username="u", password="p")
        )
    message = str(excinfo.value)
    assert "MALICIOUS" * 100 not in message
    assert message.count("MALICIOUS") <= tr.LOGIN_ERROR_BODY_LIMIT // len("MALICIOUS")
    assert len(message) < 300
    assert "truncated" in message
    assert captured.get("verify") is True  # 登录也走系统信任库校验
