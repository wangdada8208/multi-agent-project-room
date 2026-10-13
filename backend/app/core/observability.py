"""Structured log redaction and in-process observability metrics.

E-group (third audit) deliverable. Two independent, dependency-free facilities:

* ``redact`` / ``RedactingFilter`` — structured redaction for log records.
  Sensitive keys (tokens, secrets, credentials, DSNs, room bodies) are replaced
  before a record reaches a sink, including values embedded in ``record.args``
  mappings/tuples and in ``extra`` attributes. DSN credentials inside otherwise
  innocuous strings are scrubbed too.
* ``Metrics`` — a small lock-protected counter/gauge/timing registry with a
  ``snapshot()`` for tests and future exporters. No network, no threads, no
  background tasks.

Nothing here changes business behavior; instrumentation is additive. Timing uses
``time.perf_counter`` (a monotonic clock), so measurements are immune to wall
clock steps — see the E-group report section on monotonic margins.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from collections import defaultdict
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

REDACTED = "***REDACTED***"

# Substring match, case-insensitive. Ordered longest-first is unnecessary because
# we only test membership.
SENSITIVE_KEY_PARTS: tuple[str, ...] = (
    "token",
    "secret",
    "password",
    "passwd",
    "credential",
    "authorization",
    "api_key",
    "apikey",
    "private_key",
    "cookie",
    "dsn",
    "database_url",
    "bearer",
    "signature",
    "content",
    "body",
    "artifact",
)

# ``scheme://user:password@host`` -> credentials replaced, host preserved.
_DSN_CREDENTIALS = re.compile(r"(?P<scheme>[a-zA-Z][a-zA-Z0-9+.\-]*://)[^/@\s]+@")
# Bare ``key=value`` pairs that frequently carry secrets inside free-form strings.
_INLINE_SECRET = re.compile(
    r"(?i)\b(token|secret|password|passwd|api[_-]?key)\b\s*[=:]\s*([^\s,;]+)"
)
_BEARER_AUTH = re.compile(r"(?i)\b(bearer)\s+([^\s,;]+)")

_MAX_DEPTH = 6
_MAX_ITEMS = 64


def is_sensitive_key(key: Any) -> bool:
    """True when a mapping key name must never have its value logged verbatim."""
    if not isinstance(key, str):
        return False
    lowered = key.casefold()
    return any(part in lowered for part in SENSITIVE_KEY_PARTS)


def scrub_text(value: str) -> str:
    """Redact embedded DSN credentials, bearer tokens, and inline ``secret=...`` pairs."""
    if not value:
        return value
    value = _DSN_CREDENTIALS.sub(lambda m: f"{m.group('scheme')}{REDACTED}@", value)
    value = _BEARER_AUTH.sub(lambda m: f"{m.group(1)} {REDACTED}", value)
    value = _INLINE_SECRET.sub(lambda m: f"{m.group(1)}={REDACTED}", value)
    return value


def redact(value: Any, *, _depth: int = 0) -> Any:
    """Return a structurally-redacted copy safe to log.

    Mappings lose sensitive values, sequences are walked, strings are scrubbed of
    embedded credentials, and opaque scalars pass through unchanged. The input is
    never mutated.
    """
    if _depth >= _MAX_DEPTH:
        return value if isinstance(value, (int, float, bool, type(None))) else REDACTED
    if isinstance(value, dict):
        return {
            key: (REDACTED if is_sensitive_key(key) else redact(item, _depth=_depth + 1))
            for key, item in list(value.items())[:_MAX_ITEMS]
        }
    if isinstance(value, (list, tuple, set, frozenset)):
        items = [redact(item, _depth=_depth + 1) for item in list(value)[:_MAX_ITEMS]]
        return tuple(items) if isinstance(value, tuple) else items
    if isinstance(value, str):
        return scrub_text(value)
    return value


class RedactingFilter(logging.Filter):
    """Logging filter that structurally redacts a record before it is emitted."""

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: D102 - stdlib API
        if isinstance(record.msg, str):
            record.msg = scrub_text(record.msg)
        if isinstance(record.args, dict):
            record.args = redact(record.args)
        elif isinstance(record.args, tuple):
            record.args = tuple(redact(item) for item in record.args)
        for key in list(record.__dict__):
            if key.startswith("_") or key in _STANDARD_RECORD_FIELDS:
                continue
            if is_sensitive_key(key):
                record.__dict__[key] = REDACTED
        return True


_STANDARD_RECORD_FIELDS = frozenset(
    logging.LogRecord(name="", level=0, pathname="", lineno=0, msg="", args=(), exc_info=None).__dict__
)


def install_redacting_filter(logger: logging.Logger | None = None) -> RedactingFilter:
    """Attach a single ``RedactingFilter`` to ``logger`` (root by default).

    Idempotent: calling twice never stacks a second filter.
    """
    target = logger or logging.getLogger()
    for existing in target.filters:
        if isinstance(existing, RedactingFilter):
            return existing
    created = RedactingFilter()
    target.addFilter(created)
    return created


@dataclass
class Metrics:
    """Minimal counter/gauge/timing registry. Thread-safe and dependency-free."""

    _counters: dict[tuple[str, tuple[tuple[str, str], ...]], float] = field(
        default_factory=lambda: defaultdict(float)
    )
    _gauges: dict[tuple[str, tuple[tuple[str, str], ...]], float] = field(default_factory=dict)
    _timings: dict[tuple[str, tuple[tuple[str, str], ...]], list[float]] = field(
        default_factory=lambda: defaultdict(list)
    )
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @staticmethod
    def _labels(labels: dict[str, Any]) -> tuple[tuple[str, str], ...]:
        return tuple(sorted((str(key), str(value)) for key, value in labels.items()))

    def increment(self, name: str, value: float = 1, **labels: Any) -> None:
        with self._lock:
            self._counters[(name, self._labels(labels))] += value

    def gauge(self, name: str, value: float, **labels: Any) -> None:
        with self._lock:
            self._gauges[(name, self._labels(labels))] = value

    def observe(self, name: str, seconds: float, **labels: Any) -> None:
        with self._lock:
            self._timings[(name, self._labels(labels))].append(float(seconds))

    @contextmanager
    def timed(self, name: str, **labels: Any):
        started = time.perf_counter()
        try:
            yield
        finally:
            self.observe(name, time.perf_counter() - started, **labels)

    @staticmethod
    def _key_to_text(name: str, labels: tuple[tuple[str, str], ...]) -> str:
        if not labels:
            return name
        rendered = ",".join(f"{key}={value}" for key, value in labels)
        return f"{name}{{{rendered}}}"

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            counters = {
                self._key_to_text(name, labels): value
                for (name, labels), value in self._counters.items()
            }
            gauges = {
                self._key_to_text(name, labels): value
                for (name, labels), value in self._gauges.items()
            }
            timings = {}
            for (name, labels), samples in self._timings.items():
                if not samples:
                    continue
                ordered = sorted(samples)
                timings[self._key_to_text(name, labels)] = {
                    "count": len(ordered),
                    "min": ordered[0],
                    "max": ordered[-1],
                    "avg": sum(ordered) / len(ordered),
                    "p50": ordered[len(ordered) // 2],
                    "p95": ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))],
                }
        return {"counters": counters, "gauges": gauges, "timings": timings}

    def reset(self) -> None:
        with self._lock:
            self._counters.clear()
            self._gauges.clear()
            self._timings.clear()


metrics = Metrics()