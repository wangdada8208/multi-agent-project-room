"""Google Identity Services (GIS) ID token verification with cached JWKS."""
from __future__ import annotations

from dataclasses import dataclass
import logging
import time
from typing import Optional

from fastapi import HTTPException
import httpx
import jwt
from jwt.algorithms import RSAAlgorithm

from app.auth.email_otp import normalize_and_validate_email
from app.config import Settings

logger = logging.getLogger(__name__)

_GOOGLE_ISSUERS = ("https://accounts.google.com", "accounts.google.com")
_JWKS_CACHE_TTL_SECONDS = 6 * 3600
_JWKS_FORCE_REFRESH_COOLDOWN = 60.0

_jwks_cache: dict[str, object] = {
    "url": "",
    "keys_by_kid": {},
    "expires_at": 0.0,
    "last_forced_refresh": 0.0,
}


@dataclass(frozen=True)
class GoogleIdentity:
    """Verified identity extracted from a Google GIS ``id_token``."""

    sub: str
    email: str
    normalized_email: str
    name: str
    picture: Optional[str]


def reset_google_jwks_cache() -> None:
    """Clear the cached Google JWKS keys (used between tests)."""
    _jwks_cache["url"] = ""
    _jwks_cache["keys_by_kid"] = {}
    _jwks_cache["expires_at"] = 0.0
    _jwks_cache["last_forced_refresh"] = 0.0


async def _fetch_google_jwks(settings: Settings) -> dict[str, dict]:
    jwks_url = (settings.google_jwks_url or "").strip() or "https://www.googleapis.com/oauth2/v3/certs"
    proxy = (settings.oauth_http_proxy or "").strip() or None
    try:
        async with httpx.AsyncClient(timeout=5.0, proxy=proxy, trust_env=False) as client:
            resp = await client.get(jwks_url)
    except Exception as exc:
        logger.warning("Failed to fetch Google JWKS: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Google 登录公钥获取失败，请稍后重试") from None

    if resp.status_code != 200:
        logger.warning("Google JWKS endpoint returned HTTP %s", resp.status_code)
        raise HTTPException(status_code=503, detail="Google 登录公钥获取失败，请稍后重试")

    try:
        payload = resp.json()
    except Exception:
        raise HTTPException(status_code=503, detail="Google 登录公钥格式无效") from None

    keys = payload.get("keys") if isinstance(payload, dict) else None
    if not isinstance(keys, list):
        raise HTTPException(status_code=503, detail="Google 登录公钥格式无效")

    mapped: dict[str, dict] = {}
    for item in keys:
        if isinstance(item, dict) and isinstance(item.get("kid"), str) and item["kid"]:
            mapped[item["kid"]] = item
    if not mapped:
        raise HTTPException(status_code=503, detail="Google 登录公钥列表为空")

    now = time.monotonic()
    _jwks_cache["url"] = jwks_url
    _jwks_cache["keys_by_kid"] = mapped
    _jwks_cache["expires_at"] = now + _JWKS_CACHE_TTL_SECONDS
    return mapped


async def _get_jwk_for_kid(kid: str, settings: Settings) -> dict:
    jwks_url = (settings.google_jwks_url or "").strip() or "https://www.googleapis.com/oauth2/v3/certs"
    now = time.monotonic()
    cached_url = _jwks_cache.get("url")
    expires_at = float(_jwks_cache.get("expires_at") or 0.0)
    keys_by_kid = _jwks_cache.get("keys_by_kid")

    if cached_url != jwks_url or not isinstance(keys_by_kid, dict) or now >= expires_at:
        keys_by_kid = await _fetch_google_jwks(settings)

    jwk = keys_by_kid.get(kid)
    if jwk is not None:
        return jwk

    last_forced = float(_jwks_cache.get("last_forced_refresh") or 0.0)
    if now - last_forced >= _JWKS_FORCE_REFRESH_COOLDOWN:
        _jwks_cache["last_forced_refresh"] = now
        keys_by_kid = await _fetch_google_jwks(settings)
        jwk = keys_by_kid.get(kid)
        if jwk is not None:
            return jwk

    raise HTTPException(status_code=401, detail="无法识别的 Google 签名密钥")


async def verify_google_id_token(credential: str, settings: Settings) -> GoogleIdentity:
    """Verify a Google GIS ``id_token`` (RS256) and extract the verified user claims."""
    client_id = (settings.google_client_id or "").strip()
    if not client_id:
        raise HTTPException(status_code=503, detail="Google 登录尚未配置")

    if not isinstance(credential, str) or not credential.strip() or len(credential) > 8192:
        raise HTTPException(status_code=401, detail="无效的 Google 登录凭证")
    token = credential.strip()

    try:
        header = jwt.get_unverified_header(token)
    except Exception:
        raise HTTPException(status_code=401, detail="无效的 Google 登录凭证") from None

    if header.get("alg") != "RS256":
        raise HTTPException(status_code=401, detail="不支持的 Google 令牌签名算法")
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        raise HTTPException(status_code=401, detail="Google 登录凭证缺少密钥标识")

    jwk_dict = await _get_jwk_for_kid(kid, settings)
    try:
        public_key = RSAAlgorithm.from_jwk(jwk_dict)
    except Exception:
        raise HTTPException(status_code=401, detail="Google 公钥解析失败") from None

    try:
        claims = jwt.decode(
            token,
            key=public_key,
            algorithms=["RS256"],
            audience=client_id,
            issuer=list(_GOOGLE_ISSUERS),
            leeway=30,
            options={"require": ["exp", "sub", "aud", "iss"]},
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Google 登录凭证已过期，请重新登录") from None
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Google 登录凭证校验失败") from None

    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub.strip() or len(sub.strip()) > 255:
        raise HTTPException(status_code=401, detail="Google 登录凭证缺少用户标识")
    sub = sub.strip()

    if claims.get("email_verified") is not True:
        raise HTTPException(status_code=401, detail="请先在 Google 验证您的邮箱地址")

    try:
        cleaned_email, normalized_email = normalize_and_validate_email(claims.get("email", ""))
    except HTTPException:
        raise HTTPException(status_code=401, detail="Google 账号缺少有效邮箱") from None

    raw_name = claims.get("name")
    display_name = raw_name.strip()[:128] if isinstance(raw_name, str) and raw_name.strip() else cleaned_email.split("@", 1)[0][:128]

    raw_picture = claims.get("picture")
    picture: Optional[str] = None
    if isinstance(raw_picture, str):
        pic = raw_picture.strip()
        if pic.startswith("https://") and len(pic) <= 512:
            picture = pic

    return GoogleIdentity(
        sub=sub,
        email=cleaned_email,
        normalized_email=normalized_email,
        name=display_name,
        picture=picture,
    )
