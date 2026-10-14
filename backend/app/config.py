from functools import lru_cache
from typing import Any
from pydantic import SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings

INSECURE_SECRET_BLACKLIST = {
    "dev-change-me",
    "change-me-before-production",
    "change-me",
    "changeme",
    "replace-me",
    "replace-with-openssl-rand-hex-32-in-production",
    "your-secret-key",
    "placeholder",
    "secret",
    "admin",
    "password",
    "default",
    "example",
}


class Settings(BaseSettings):
    app_name: str = "Multi-Agent Project Room Demo"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173", "https://hub.wangdada8208.xyz"]
    database_url: str = "postgresql+asyncpg://postgres:password@localhost:5432/agent_room"
    repository_root: str = "/data/repos"
    redis_url: str = "redis://localhost:6379/0"
    a2a_host: str = "0.0.0.0"
    a2a_port: int = 8765
    a2a_public_url: str = "http://localhost:8000"
    a2a_protocol_version: str = "1.0.0"
    a2a_task_timeout_seconds: int = 300
    message_retention_days: int = 15
    auth_secret_key: str = "dev-change-me"
    agent_enrollment_secret: SecretStr = SecretStr("")
    auth_token_ttl_minutes: int = 60 * 24 * 7
    rate_limit_per_minute: int = 60
    environment: str = "development"
    trusted_proxies: list[str] = ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]

    model_config = {"env_file": ".env", "env_prefix": "MAPR_"}

    @field_validator("trusted_proxies", mode="before")
    @classmethod
    def parse_trusted_proxies(cls, v: Any) -> list[str]:
        if isinstance(v, str):
            v = v.strip()
            if not v:
                return []
            if v.startswith("[") and v.endswith("]"):
                import json
                try:
                    parsed = json.loads(v)
                    if isinstance(parsed, list):
                        return [str(item).strip() for item in parsed if str(item).strip()]
                except Exception:
                    pass
            return [item.strip() for item in v.split(",") if item.strip()]
        return v

    @model_validator(mode="after")
    def validate_production_secrets(self) -> "Settings":
        env = (self.environment or "").strip().lower()
        if env not in ("development", "test", "testing", "dev"):
            key = self.auth_secret_key or ""
            stripped = key.strip()
            if not stripped or key != stripped:
                raise ValueError(
                    "MAPR_AUTH_SECRET_KEY must not contain leading or trailing whitespace and cannot be empty"
                )
            if len(stripped) < 32:
                raise ValueError(
                    "MAPR_AUTH_SECRET_KEY must be configured with >=32 chars in non-development environments"
                )
            if stripped.lower() in INSECURE_SECRET_BLACKLIST:
                raise ValueError(
                    f"MAPR_AUTH_SECRET_KEY cannot use known insecure placeholder '{stripped}'"
                )
            if len(set(stripped)) < 4:
                raise ValueError(
                    "MAPR_AUTH_SECRET_KEY has insufficient character entropy (must contain at least 4 unique characters)"
                )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
