from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "Multi-Agent Project Room Demo"
    cors_origins: list[str] = ["*"]
    database_url: str = "postgresql+asyncpg://postgres:password@localhost:5432/agent_room"
    redis_url: str = "redis://localhost:6379/0"
    a2a_host: str = "0.0.0.0"
    a2a_port: int = 8765
    a2a_public_url: str = "http://localhost:8000"
    a2a_protocol_version: str = "0.3.0"
    message_retention_days: int = 15

    model_config = {"env_file": ".env", "env_prefix": "MAPR_"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
