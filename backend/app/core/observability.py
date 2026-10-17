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
from collections import OrderedDict, defaultdict, deque
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
# Matches PEM / OpenSSH / RSA / EC private key blocks
_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9_-]+ )?PRIVATE KEY-----",
    re.IGNORECASE,
)
# scheme://user:password@host -> credentials replaced, host preserved.
_DSN_CREDENTIALS = re.compile(r"(?P<scheme>[a-zA-Z][a-zA-Z0-9+.\-]*://)[^/@\s]+@")
# Bare key=value pairs that frequently carry secrets inside free-form strings.
_INLINE_SECRET = re.compile(
    '(?i)\\b(token|secret|password|passwd|api[_-]?key)\\b\\s*[=:]\\s*(?:\\"[^\\"]*\\"|\'[^\']*\'|([^\\s,;]+))'
)
_BEARER_AUTH = re.compile('(?i)\\b(bearer)\\s+([^\\s,;\\"\']+)')
# Credentials that travel in the URL *path*. Anchored to the known routes, so
# ordinary path segments (room ids etc.) survive:
#   /api/v1/invites/<token>[/redeem]          invite links
#   /api/v1/rooms/shared/<token>/messages     read-only share data (real route)
#   /api/v1/shared/<token>                    alias form
#   /api/v1/rooms/<room_id>/share/<token>     share link revocation
_PATH_SECRET_SEGMENT = re.compile(
    r"(?i)(?P<prefix>/api/v1/(?:invites|shared)/)[^/\s?#\"']+"
    r"|(?P<prefix2>/api/v1/rooms/shared/)[^/\s?#\"']+"
    r"|(?P<prefix3>/api/v1/rooms/[^/\s?#\"']+/share/)[^/\s?#\"']+"
)
# Credentials smuggled into a query string: ?token= / &access_token= / ...
_QUERY_SECRET = re.compile(
    r"(?i)([?&](?:token|access_token|refresh_token|invite_token|invite|key|api_key|secret)=)[^&\s\"']+"
)
# Placeholder run emitted by Python's logging for one or more ``%s``-style args.
# Deliberately not ``%d``/``%f``: digits may legitimately survive a scrub.
_ARG_SLOT = re.compile(
    r"%(?:\((?P<key>[^)]*)\))?[#0\- +]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[s]"
)

_MAX_DEPTH = 6
_MAX_ITEMS = 64


def is_sensitive_key(key: Any) -> bool:
    """True when a mapping key name must never have its value logged verbatim."""
    if not isinstance(key, str):
        return False
    lowered = key.casefold()
    return any(part in lowered for part in SENSITIVE_KEY_PARTS)


def scrub_text(value: str) -> str:
    """Redact embedded DSN credentials, bearer tokens, and inline secret=... pairs.

    Also removes credentials that travel inside a URL: the invite token path
    segment and ``?token=``-style query strings. Without this, uvicorn's access
    log records the invite token verbatim (audit round 4, finding H1).
    """
    return _scrub_text_ex(value)[0]


def _scrub_text_ex(value: str) -> tuple[str, bool]:
    """``scrub_text`` plus a "did anything get masked" flag.

    The flag drives M1 handling: only a record whose template actually carried a
    secret needs its args neutralised. A plain access-log record keeps rendering
    normally, so operators keep seeing method/path/status.
    """
    if not value or not isinstance(value, str):
        return value, False
    original = value
    value = _PRIVATE_KEY_RE.sub(REDACTED, value)
    value = _DSN_CREDENTIALS.sub(lambda m: f"{m.group('scheme')}{REDACTED}@", value)
    value = _BEARER_AUTH.sub(lambda m: f"{m.group(1)} {REDACTED}", value)
    value = _PATH_SECRET_SEGMENT.sub(
        lambda m: f"{m.group('prefix') or m.group('prefix2') or m.group('prefix3')}{REDACTED}",
        value,
    )
    value = _QUERY_SECRET.sub(lambda m: f"{m.group(1)}{REDACTED}", value)
    value = _INLINE_SECRET.sub(lambda m: f"{m.group(1)}={REDACTED}", value)
    return value, value != original


def _scrub_record_args(msg: Any, args: Any, *, template_masked: bool) -> Any:
    """Redact log args and make the record impossible to un-redact at format time.

    M1: scrubbing ``msg`` alone changes the template while ``args`` keeps the
    original secrets. Python's ``LogRecord.getMessage()`` then does
    ``msg % args`` again, which either re-injects the secret or raises
    ``TypeError`` (``raiseExceptions`` also echoes the raw args to stderr) and
    drops the whole record.

    H1 (second half): the access log passes method/path/status through ``args``.
    Masking the whole record whenever *one* arg carried a secret hid the very
    information operators need. So each arg is scrubbed in place and the record
    keeps rendering normally: the secret is masked, the route and status stay.

    Only when the *template* was rewritten does the slot structure become
    untrustworthy; then the message collapses to its prefix plus one marker and
    ``args`` is emptied, so nothing can be re-injected.
    """
    if isinstance(args, dict):
        return (msg, ()) if template_masked else (msg, redact(args))
    if not isinstance(args, tuple):
        return msg, args
    scrubbed = tuple(
        redact(item) if isinstance(item, (dict, list))
        else (scrub_text(item) if isinstance(item, str) else item)
        for item in args
    )
    if not template_masked:
        # Per-arg redaction is complete and the template is intact, so the record
        # formats exactly as before, with every secret already masked.
        return msg, scrubbed
    if not scrubbed or not isinstance(msg, str):
        return msg, scrubbed
    slots = [m for m in _ARG_SLOT.finditer(msg) if not m.group("key")]
    if not slots:
        # A redaction rule already consumed the placeholder (``Bearer %s`` ->
        # ``Bearer ***``): the dynamic part is masked already.
        return msg, ()
    # The slot structure can no longer be trusted, so everything from the first
    # slot on becomes one opaque marker: no placeholder survives, nothing can be
    # re-injected or echoed.
    return msg[: slots[0].start()] + REDACTED, ()


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
        if getattr(record, "_redacted", False):
            return True
        template_masked = False
        if isinstance(record.msg, str):
            record.msg, template_masked = _scrub_text_ex(record.msg)
        elif isinstance(record.msg, (dict, list)):
            record.msg = redact(record.msg)
        if isinstance(record.args, tuple) or isinstance(record.args, dict):
            # M1: the template may have been rewritten above; realign the args
            # with it so a secret can never be re-injected at formatting time.
            record.msg, record.args = _scrub_record_args(
                record.msg, record.args, template_masked=template_masked
            )
        for key in list(record.__dict__):
            if key.startswith("_") or key in _STANDARD_RECORD_FIELDS:
                continue
            if is_sensitive_key(key):
                record.__dict__[key] = REDACTED
            else:
                record.__dict__[key] = redact(record.__dict__[key])
        if record.exc_info and not record.exc_text:
            formatted = logging.Formatter().formatException(record.exc_info)
            record.exc_text = scrub_text(formatted)
            record.exc_info = None
        elif record.exc_text:
            record.exc_text = scrub_text(record.exc_text)
        record._redacted = True
        return True


_STANDARD_RECORD_FIELDS = frozenset(
    logging.LogRecord(name="", level=0, pathname="", lineno=0, msg="", args=(), exc_info=None).__dict__
)

_HOOK_INSTALLED: bool = False


def install_redacting_filter(logger: logging.Logger | None = None) -> RedactingFilter:
    """Attach RedactingFilter across root, loggers, and handlers.

    Idempotent: calling twice never stacks duplicate filters. Automatically
    patches logging.Logger.addHandler so dynamically added handlers
    inherit redaction.
    """
    global _HOOK_INSTALLED
    created = RedactingFilter()

    def _attach(target: logging.Logger | logging.Handler) -> None:
        """Keep exactly one filter on ``target``, replacing any stale instance.

        ``install_redacting_filter`` is idempotent, but "idempotent" must mean
        "the current class", not "the first instance ever created": a name that
        was set up by an older module object (test reloads, plugin reloads)
        would otherwise keep an outdated filter alive forever.
        """
        stale = [f for f in target.filters if isinstance(f, RedactingFilter)]
        for old in stale:
            target.removeFilter(old)
        target.addFilter(created)

    if not _HOOK_INSTALLED:
        orig_add_handler = logging.Logger.addHandler

        def safe_add_handler(self: logging.Logger, hdlr: logging.Handler) -> None:
            if not any(isinstance(f, RedactingFilter) for f in hdlr.filters):
                hdlr.addFilter(RedactingFilter())
            orig_add_handler(self, hdlr)

        logging.Logger.addHandler = safe_add_handler
        _HOOK_INSTALLED = True

    targets: list[logging.Logger] = [logging.getLogger()]
    if logger is not None:
        targets.append(logger)

    for name in ("fastapi", "uvicorn", "uvicorn.access", "uvicorn.error", "app"):
        targets.append(logging.getLogger(name))

    for item in list(logging.Logger.manager.loggerDict.values()):
        if isinstance(item, logging.Logger):
            targets.append(item)

    for log in targets:
        _attach(log)
        for handler in log.handlers:
            _attach(handler)

    return created


@dataclass
class Metrics:
    """Minimal counter/gauge/timing registry with bounded memory. Thread-safe and dependency-free."""

    max_samples_per_timing: int = 1000
    max_series: int = 1000
    _counters: OrderedDict[tuple[str, tuple[tuple[str, str], ...]], float] = field(
        default_factory=OrderedDict
    )
    _gauges: OrderedDict[tuple[str, tuple[tuple[str, str], ...]], float] = field(
        default_factory=OrderedDict
    )
    _timings: OrderedDict[tuple[str, tuple[tuple[str, str], ...]], deque[float]] = field(
        default_factory=OrderedDict
    )
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @staticmethod
    def _labels(labels: dict[str, Any]) -> tuple[tuple[str, str], ...]:
        return tuple(sorted((str(key), str(value)) for key, value in labels.items()))

    def increment(self, name: str, value: float = 1, **labels: Any) -> None:
        key = (name, self._labels(labels))
        with self._lock:
            if key in self._counters:
                self._counters[key] += float(value)
                self._counters.move_to_end(key)
            else:
                if len(self._counters) >= self.max_series:
                    self._counters.popitem(last=False)
                self._counters[key] = float(value)

    def gauge(self, name: str, value: float, **labels: Any) -> None:
        key = (name, self._labels(labels))
        with self._lock:
            if key in self._gauges:
                self._gauges[key] = float(value)
                self._gauges.move_to_end(key)
            else:
                if len(self._gauges) >= self.max_series:
                    self._gauges.popitem(last=False)
                self._gauges[key] = float(value)

    def observe(self, name: str, seconds: float, **labels: Any) -> None:
        key = (name, self._labels(labels))
        with self._lock:
            if key in self._timings:
                self._timings[key].append(float(seconds))
                self._timings.move_to_end(key)
            else:
                if len(self._timings) >= self.max_series:
                    self._timings.popitem(last=False)
                dq: deque[float] = deque(maxlen=self.max_samples_per_timing)
                dq.append(float(seconds))
                self._timings[key] = dq

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