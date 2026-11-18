"""Email normalization, OTP issuance/consumption, and multi-provider delivery."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr
import hashlib
import hmac
import html
import logging
import os
import re
import secrets
import smtplib
import sys
import time
import unicodedata
from typing import Any, Literal
import urllib.parse

from fastapi import HTTPException
import httpx

from app.config import Settings

logger = logging.getLogger(__name__)

MAX_OTP_ATTEMPTS = 5
MAX_FALLBACK_KEYS = 10_000
_REDIS_TIMEOUT_SECONDS = 0.2
_REDIS_COOLOFF_SECONDS = 60.0
_KEY_PREFIX = "mapr:email_otp:"

_LOCAL_PART_RE = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$")
_DOMAIN_LABEL_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
_OTP_CODE_RE = re.compile(r"^\d{6}$")

# Bounded dev/test outbox (populated only when email_provider == "console" in dev/test).
TEST_EMAIL_OUTBOX: list[dict[str, str]] = []
_MAX_OUTBOX_LEN = 100

LUA_VERIFY_AND_CONSUME_OTP = """
-- KEYS[1]: OTP hash key (fields: digest, attempts)
-- ARGV[1]: expected_digest
-- ARGV[2]: max_attempts
-- Returns:
--   0 = matched and consumed
--   1 = missing or expired
--   2 = locked out (max attempts reached; key deleted)
--   3 = mismatch (attempt counter incremented)
if redis.call('EXISTS', KEYS[1]) == 0 then
    return 1
end
local stored = redis.call('HGET', KEYS[1], 'digest')
local attempts = tonumber(redis.call('HGET', KEYS[1], 'attempts') or '0')
local max_attempts = tonumber(ARGV[2])
if stored == ARGV[1] then
    redis.call('DEL', KEYS[1])
    return 0
end
attempts = attempts + 1
if attempts >= max_attempts then
    redis.call('DEL', KEYS[1])
    return 2
end
redis.call('HSET', KEYS[1], 'attempts', tostring(attempts))
return 3
"""


class _BoundedDict(OrderedDict):
    def __init__(self, max_keys: int = MAX_FALLBACK_KEYS) -> None:
        super().__init__()
        self._max_keys = max(1, int(max_keys))

    def __setitem__(self, key: Any, value: Any) -> None:
        super().__setitem__(key, value)
        self.move_to_end(key)
        while len(self) > self._max_keys:
            self.popitem(last=False)


# In-process fallback maps:
# _fallback_codes[key] = (digest, attempts, expires_at_monotonic)
# _fallback_cooldowns[key] = cooldown_until_monotonic
_fallback_codes: _BoundedDict = _BoundedDict()
_fallback_cooldowns: _BoundedDict = _BoundedDict()

_redis_async_client: Any = None
_redis_async_loop: Any = None
_redis_sync_client: Any = None
_redis_open_until: float = 0.0


def _is_test_environment() -> bool:
    if os.environ.get("MAPR_TESTING") or os.environ.get("MAPR_TEST_REDIS_URL") or os.environ.get("MAPR_TEST_DATABASE_URL"):
        return True
    if os.environ.get("PYTEST_CURRENT_TEST") is not None:
        return True
    return "pytest" in sys.modules


def _effective_redis_url(settings: Settings) -> str:
    test_url = os.environ.get("MAPR_TEST_REDIS_URL")
    if test_url:
        return test_url
    base_url = settings.redis_url
    if _is_test_environment() and not os.environ.get("MAPR_REDIS_URL"):
        test_db = os.environ.get("MAPR_TEST_REDIS_DB", "15")
        parsed = urllib.parse.urlsplit(base_url)
        return urllib.parse.urlunsplit(
            (parsed.scheme, parsed.netloc, f"/{test_db}", parsed.query, parsed.fragment)
        )
    return base_url


def _trip_redis_breaker() -> None:
    global _redis_async_client, _redis_async_loop, _redis_sync_client, _redis_open_until
    _redis_async_client = None
    _redis_async_loop = None
    _redis_sync_client = None
    _redis_open_until = time.monotonic() + _REDIS_COOLOFF_SECONDS


async def _get_redis_async(settings: Settings) -> Any:
    global _redis_async_client, _redis_async_loop
    if time.monotonic() < _redis_open_until:
        return None
    loop = asyncio.get_running_loop()
    if _redis_async_client is not None and _redis_async_loop is not loop:
        _redis_async_client = None
        _redis_async_loop = None
    if _redis_async_client is None:
        try:
            import redis.asyncio as redis_asyncio

            client = redis_asyncio.Redis.from_url(
                _effective_redis_url(settings),
                socket_timeout=_REDIS_TIMEOUT_SECONDS,
                socket_connect_timeout=_REDIS_TIMEOUT_SECONDS,
                decode_responses=True,
            )
            await client.ping()
        except Exception:
            _trip_redis_breaker()
            return None
        _redis_async_client = client
        _redis_async_loop = loop
    return _redis_async_client


def reset_email_otp_state() -> None:
    """Reset in-memory OTP state, outbox, and test-scoped Redis OTP keys."""
    global _redis_async_client, _redis_async_loop, _redis_sync_client, _redis_open_until
    _fallback_codes.clear()
    _fallback_cooldowns.clear()
    TEST_EMAIL_OUTBOX.clear()
    _redis_async_client = None
    _redis_async_loop = None
    _redis_sync_client = None
    _redis_open_until = 0.0

    if not _is_test_environment() and not os.environ.get("MAPR_ALLOW_REDIS_FLUSH"):
        return
    try:
        import redis
        from app.config import get_settings

        client = redis.Redis.from_url(
            _effective_redis_url(get_settings()),
            socket_timeout=_REDIS_TIMEOUT_SECONDS,
            socket_connect_timeout=_REDIS_TIMEOUT_SECONDS,
            decode_responses=True,
        )
        client.ping()
        keys = [k for k in client.scan_iter(match=f"{_KEY_PREFIX}*", count=500)]
        if keys:
            client.delete(*keys)
        client.close()
    except Exception:
        pass


def normalize_and_validate_email(raw: str) -> tuple[str, str]:
    """Validate an email address and return ``(cleaned_email, normalized_email)``."""
    if not isinstance(raw, str):
        raise HTTPException(status_code=422, detail="请输入有效的邮箱地址")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in raw):
        raise HTTPException(status_code=422, detail="邮箱包含非法控制字符")

    cleaned = unicodedata.normalize("NFKC", raw).strip()
    if len(cleaned) < 5 or len(cleaned) > 254 or any(ch.isspace() for ch in cleaned):
        raise HTTPException(status_code=422, detail="请输入有效的邮箱地址")

    local, sep, domain = cleaned.partition("@")
    if not sep or "@" in domain:
        raise HTTPException(status_code=422, detail="请输入有效的邮箱地址")

    if (
        not local
        or len(local) > 64
        or local.startswith(".")
        or local.endswith(".")
        or ".." in local
        or not _LOCAL_PART_RE.fullmatch(local)
    ):
        raise HTTPException(status_code=422, detail="请输入有效的邮箱地址")

    if (
        not domain
        or len(domain) > 253
        or "." not in domain
        or domain.startswith(".")
        or domain.endswith(".")
        or ".." in domain
    ):
        raise HTTPException(status_code=422, detail="请输入有效的邮箱地址")

    labels = domain.split(".")
    if any(not _DOMAIN_LABEL_RE.fullmatch(label) for label in labels):
        raise HTTPException(status_code=422, detail="请输入有效的邮箱地址")
    tld = labels[-1]
    if len(tld) < 2 or not (tld.isalpha() or tld.lower().startswith("xn--")):
        raise HTTPException(status_code=422, detail="请输入有效的邮箱地址")

    return cleaned, cleaned.lower()


def _otp_digest(settings: Settings, purpose: str, normalized_email: str, code: str) -> str:
    msg = f"{purpose}:{normalized_email}:{code}".encode("utf-8")
    key = settings.auth_secret_key.encode("utf-8")
    return hmac.new(key, msg, hashlib.sha256).hexdigest()


def _code_key(purpose: str, normalized_email: str) -> str:
    return f"{_KEY_PREFIX}code:{purpose}:{normalized_email}"


def _cooldown_key(purpose: str, normalized_email: str) -> str:
    return f"{_KEY_PREFIX}cd:{purpose}:{normalized_email}"


def email_is_configured(settings: Settings) -> bool:
    provider = (settings.email_provider or "").strip().lower()
    if provider == "cloudflare_worker":
        return bool(settings.email_worker_url.strip() and settings.email_worker_secret.get_secret_value().strip())
    if provider == "resend":
        return bool(settings.email_api_key.get_secret_value().strip() and settings.email_from_address.strip())
    if provider == "smtp":
        return bool(settings.smtp_host.strip() and settings.email_from_address.strip())
    if provider == "console":
        env = (settings.environment or "").strip().lower()
        return env in ("development", "test", "testing", "dev")
    return False


async def check_email_otp_cooldown(
    normalized_email: str,
    purpose: Literal["register", "login"],
    settings: Settings,
    *,
    reserve: bool = True,
) -> None:
    """Enforce resend cooldown; optionally reserve the cooldown window."""
    cooldown = max(1, int(settings.email_otp_cooldown_seconds))
    cd_key = _cooldown_key(purpose, normalized_email)

    client = await _get_redis_async(settings)
    if client is not None:
        try:
            if reserve:
                ok = await client.set(cd_key, "1", ex=cooldown, nx=True)
                if not ok:
                    raise HTTPException(status_code=429, detail=f"发送过于频繁，请 {cooldown} 秒后再试")
                return
            exists = await client.exists(cd_key)
            if exists:
                raise HTTPException(status_code=429, detail=f"发送过于频繁，请 {cooldown} 秒后再试")
            return
        except HTTPException:
            raise
        except Exception:
            _trip_redis_breaker()

    now = time.monotonic()
    until = _fallback_cooldowns.get(cd_key, 0.0)
    if now < until:
        raise HTTPException(status_code=429, detail=f"发送过于频繁，请 {cooldown} 秒后再试")
    if reserve:
        _fallback_cooldowns[cd_key] = now + cooldown


async def issue_email_otp(
    normalized_email: str,
    purpose: Literal["register", "login"],
    settings: Settings,
) -> str:
    """Atomically reserve resend cooldown and store a fresh 6-digit OTP digest."""
    await check_email_otp_cooldown(normalized_email, purpose, settings, reserve=True)

    ttl = max(60, int(settings.email_otp_ttl_seconds))
    code = f"{secrets.randbelow(1_000_000):06d}"
    digest = _otp_digest(settings, purpose, normalized_email, code)
    c_key = _code_key(purpose, normalized_email)

    client = await _get_redis_async(settings)
    if client is not None:
        try:
            pipe = client.pipeline(transaction=True)
            pipe.delete(c_key)
            pipe.hset(c_key, mapping={"digest": digest, "attempts": "0"})
            pipe.expire(c_key, ttl)
            await pipe.execute()
            return code
        except Exception:
            _trip_redis_breaker()

    _fallback_codes[c_key] = (digest, 0, time.monotonic() + ttl)
    return code


async def revoke_email_otp(
    normalized_email: str,
    purpose: Literal["register", "login"],
    settings: Settings,
) -> None:
    """Clear stored OTP and cooldown (used when outbound email delivery fails)."""
    c_key = _code_key(purpose, normalized_email)
    cd_key = _cooldown_key(purpose, normalized_email)

    client = await _get_redis_async(settings)
    if client is not None:
        try:
            await client.delete(c_key, cd_key)
        except Exception:
            _trip_redis_breaker()

    _fallback_codes.pop(c_key, None)
    _fallback_cooldowns.pop(cd_key, None)


async def verify_and_consume_email_otp(
    normalized_email: str,
    code: str,
    purpose: Literal["register", "login"],
    settings: Settings,
) -> None:
    """Verify and atomically consume a 6-digit OTP, enforcing max attempt limits."""
    code_clean = (code or "").strip()
    if not _OTP_CODE_RE.fullmatch(code_clean):
        raise HTTPException(status_code=400, detail="请输入 6 位数字验证码")

    expected_digest = _otp_digest(settings, purpose, normalized_email, code_clean)
    c_key = _code_key(purpose, normalized_email)

    client = await _get_redis_async(settings)
    if client is not None:
        try:
            result = await client.eval(
                LUA_VERIFY_AND_CONSUME_OTP,
                1,
                c_key,
                expected_digest,
                str(MAX_OTP_ATTEMPTS),
            )
            if result == 0:
                return
            if result == 1:
                raise HTTPException(status_code=400, detail="验证码已过期或不存在，请重新获取")
            if result == 2:
                raise HTTPException(status_code=400, detail="验证码错误次数过多，请重新获取")
            raise HTTPException(status_code=400, detail="验证码错误")
        except HTTPException:
            raise
        except Exception:
            _trip_redis_breaker()

    entry = _fallback_codes.get(c_key)
    now = time.monotonic()
    if entry is None:
        raise HTTPException(status_code=400, detail="验证码已过期或不存在，请重新获取")
    stored_digest, attempts, expires_at = entry
    if now >= expires_at:
        _fallback_codes.pop(c_key, None)
        raise HTTPException(status_code=400, detail="验证码已过期或不存在，请重新获取")

    if hmac.compare_digest(stored_digest, expected_digest):
        _fallback_codes.pop(c_key, None)
        return

    attempts += 1
    if attempts >= MAX_OTP_ATTEMPTS:
        _fallback_codes.pop(c_key, None)
        raise HTTPException(status_code=400, detail="验证码错误次数过多，请重新获取")

    _fallback_codes[c_key] = (stored_digest, attempts, expires_at)
    raise HTTPException(status_code=400, detail="验证码错误")


def _build_otp_email_content(code: str, purpose: str, ttl_seconds: int) -> tuple[str, str, str]:
    ttl_minutes = max(1, (ttl_seconds + 59) // 60)
    action = "注册账号" if purpose == "register" else "登录账户"
    subject = f"【Multi-Agent Project Room】{action}验证码"
    text_body = (
        f"您正在通过邮箱{action}。\n\n"
        f"验证码：{code}\n"
        f"有效期：{ttl_minutes} 分钟。\n\n"
        "请勿将验证码转发或泄露给他人。如非本人操作，请忽略此邮件。"
    )
    escaped_code = html.escape(code)
    escaped_action = html.escape(action)
    html_body = (
        "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"
        "max-width:460px;margin:0 auto;padding:24px;color:#1d1d1f;\">"
        f"<h2 style=\"margin:0 0 12px;font-size:18px;\">Multi-Agent Project Room {escaped_action}</h2>"
        "<p style=\"margin:0 0 16px;font-size:14px;color:#555;\">请使用以下 6 位验证码完成验证：</p>"
        f"<div style=\"font-size:30px;font-weight:700;letter-spacing:6px;padding:14px 18px;"
        f"background:#f5f5f7;border-radius:10px;text-align:center;color:#111;\">{escaped_code}</div>"
        f"<p style=\"margin:16px 0 0;font-size:12px;color:#86868b;\">验证码 {ttl_minutes} 分钟内有效。"
        "请勿转发给他人；如非本人操作请忽略本邮件。</p>"
        "</div>"
    )
    return subject, text_body, html_body


def _send_smtp_sync(
    *,
    host: str,
    port: int,
    username: str,
    password: str,
    use_ssl: bool,
    from_address: str,
    from_name: str,
    to_email: str,
    subject: str,
    text_body: str,
    html_body: str,
) -> None:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((from_name, from_address))
    msg["To"] = to_email
    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")

    if use_ssl:
        with smtplib.SMTP_SSL(host, port, timeout=10) as smtp:
            if username:
                smtp.login(username, password)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=10) as smtp:
            smtp.ehlo()
            smtp.starttls()
            smtp.ehlo()
            if username:
                smtp.login(username, password)
            smtp.send_message(msg)


async def send_verification_email(
    to_email: str,
    code: str,
    purpose: Literal["register", "login"],
    settings: Settings,
) -> None:
    """Deliver a 6-digit verification email through the configured provider."""
    provider = (settings.email_provider or "").strip().lower()
    if not email_is_configured(settings):
        raise HTTPException(status_code=503, detail="邮件服务尚未配置")

    subject, text_body, html_body = _build_otp_email_content(
        code, purpose, settings.email_otp_ttl_seconds
    )
    from_address = settings.email_from_address.strip()
    from_name = settings.email_from_name.strip() or "Multi-Agent Project Room"

    if provider == "console":
        env = (settings.environment or "").strip().lower()
        if env not in ("development", "test", "testing", "dev"):
            raise HTTPException(status_code=503, detail="邮件服务不可用")
        TEST_EMAIL_OUTBOX.append(
            {
                "to": to_email,
                "code": code,
                "purpose": purpose,
                "subject": subject,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        if len(TEST_EMAIL_OUTBOX) > _MAX_OUTBOX_LEN:
            del TEST_EMAIL_OUTBOX[:-_MAX_OUTBOX_LEN]
        return

    if provider == "cloudflare_worker":
        worker_url = settings.email_worker_url.strip()
        worker_secret = settings.email_worker_secret.get_secret_value().strip()
        try:
            async with httpx.AsyncClient(timeout=8.0, trust_env=False) as client:
                resp = await client.post(
                    worker_url,
                    headers={
                        "Authorization": f"Bearer {worker_secret}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "to": to_email,
                        "from_email": from_address,
                        "from_name": from_name,
                        "subject": subject,
                        "text": text_body,
                        "html": html_body,
                    },
                )
        except Exception as exc:
            logger.warning("Cloudflare worker email delivery failed: %s", type(exc).__name__)
            raise HTTPException(status_code=502, detail="邮件发送失败，请稍后重试") from None
        if resp.status_code >= 400:
            logger.warning("Cloudflare worker email rejected with HTTP %s", resp.status_code)
            raise HTTPException(status_code=502, detail="邮件发送失败，请稍后重试")
        return

    if provider == "resend":
        api_key = settings.email_api_key.get_secret_value().strip()
        api_url = settings.email_api_url.strip() or "https://api.resend.com/emails"
        try:
            async with httpx.AsyncClient(timeout=8.0, trust_env=False) as client:
                resp = await client.post(
                    api_url,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "from": formataddr((from_name, from_address)),
                        "to": [to_email],
                        "subject": subject,
                        "text": text_body,
                        "html": html_body,
                    },
                )
        except Exception as exc:
            logger.warning("Resend email delivery failed: %s", type(exc).__name__)
            raise HTTPException(status_code=502, detail="邮件发送失败，请稍后重试") from None
        if resp.status_code >= 400:
            logger.warning("Resend email rejected with HTTP %s", resp.status_code)
            raise HTTPException(status_code=502, detail="邮件发送失败，请稍后重试")
        return

    if provider == "smtp":
        try:
            await asyncio.to_thread(
                _send_smtp_sync,
                host=settings.smtp_host.strip(),
                port=int(settings.smtp_port),
                username=settings.smtp_username.strip(),
                password=settings.smtp_password.get_secret_value(),
                use_ssl=bool(settings.smtp_use_ssl),
                from_address=from_address,
                from_name=from_name,
                to_email=to_email,
                subject=subject,
                text_body=text_body,
                html_body=html_body,
            )
        except Exception as exc:
            logger.warning("SMTP email delivery failed: %s", type(exc).__name__)
            raise HTTPException(status_code=502, detail="邮件发送失败，请稍后重试") from None
        return

    raise HTTPException(status_code=503, detail="邮件服务尚未配置")
