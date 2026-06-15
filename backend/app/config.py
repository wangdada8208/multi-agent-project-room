from functools import lru_cache
from pydantic import BaseSettings


class Settings(BaseSettings):
    app_name: str = "Multi-Agent Project Room Demo"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    class Config:
        env_file = ".env"
        env_prefix = "MAPR_"


@lru_cache
def get_settings() -> Settings:
    return Settings()
