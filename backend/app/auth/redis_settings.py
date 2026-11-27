"""Redis database selection and test cleanup policy for authentication."""

import os
import sys
from urllib.parse import urlsplit, urlunsplit

from app.config import Settings, get_settings


def is_test_environment() -> bool:
    if os.environ.get("MAPR_TESTING") or os.environ.get("MAPR_TEST_REDIS_URL") or os.environ.get("MAPR_TEST_DATABASE_URL"):
        return True
    if os.environ.get("PYTEST_CURRENT_TEST") is not None:
        return True
    return "pytest" in sys.modules


def effective_redis_url(settings: Settings | None = None) -> str:
    test_url = os.environ.get("MAPR_TEST_REDIS_URL")
    if test_url:
        return test_url

    base_url = (get_settings() if settings is None else settings).redis_url
    if not is_test_environment() or os.environ.get("MAPR_REDIS_URL"):
        return base_url

    test_db = os.environ.get("MAPR_TEST_REDIS_DB", "15")
    parsed = urlsplit(base_url)
    return urlunsplit((parsed.scheme, parsed.netloc, f"/{test_db}", parsed.query, parsed.fragment))


def can_reset_redis() -> bool:
    return is_test_environment() or bool(os.environ.get("MAPR_ALLOW_REDIS_FLUSH"))
