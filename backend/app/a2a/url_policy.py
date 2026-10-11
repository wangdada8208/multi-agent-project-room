from __future__ import annotations

"""Agent Card URL Policy and SSRF Defense.

Enforces strict URL validation and outbound request controls for Agent Card discovery
and health checking:
- Restricts schemes strictly to http and https
- Prohibits userinfo (credentials in URLs)
- Blocks loopback, private RFC 1918, link-local, carrier-grade NAT, multicast,
  reserved, unspecified, and cloud metadata addresses
- Detects IPv4 obfuscation (decimal dword, octal, hex, shortened forms, leading zeros)
- Checks IPv6-mapped IPv4 addresses (e.g. ::ffff:127.0.0.1)
- Blocks cloud metadata hostnames and internal TLD suffixes
- Validates all resolved DNS records fail-closed (rejects mixed/rebound records)
- Pins outbound requests to pre-verified IP addresses with Host and TLS SNI pinning
- Disables environment proxies (trust_env=False) and redirects (follow_redirects=False)
- Provides server-side static allowlist for local agent testing (default disabled,
  never allows cloud metadata or arbitrary private networks).
"""

from dataclasses import dataclass
import ipaddress
import logging
import os
import socket
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger(__name__)

CLOUD_METADATA_HOSTNAMES = {
    "metadata.google.internal",
    "instance-data",
    "metadata.azure.com",
    "169.254.169.254",
    "169.254.169.253",
    "100.100.100.200",
    "fd00:ec2::254",
}

FORBIDDEN_HOST_SUFFIXES = (
    ".local",
    ".internal",
    ".lan",
    ".corp",
    ".home",
    ".arpa",
)


class SSRFValidationError(ValueError):
    """Raised when a URL violates the SSRF safety policy."""
    pass


@dataclass(frozen=True)
class ValidatedTarget:
    """Safe pre-validated target endpoint."""
    scheme: str
    original_host: str
    port: int
    pinned_ip: str
    is_ipv6: bool
    base_path: str
    is_allowlisted_local: bool = False


def is_disallowed_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> tuple[bool, str]:
    """Check if an IP address belongs to any disallowed/internal/special network range."""
    # Check IPv6-mapped IPv4 address (e.g. ::ffff:127.0.0.1)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        disallowed, reason = is_disallowed_ip(ip.ipv4_mapped)
        if disallowed:
            return True, f"ipv4_mapped: {reason}"

    if ip.is_loopback:
        return True, "loopback address"
    if ip.is_private:
        return True, "private network"
    if ip.is_link_local:
        return True, "link-local address"
    if ip.is_multicast:
        return True, "multicast address"
    if ip.is_reserved:
        return True, "reserved address"
    if ip.is_unspecified:
        return True, "unspecified address"
    if not ip.is_global:
        return True, "non-global address"

    # Explicit cloud metadata checks
    str_ip = str(ip)
    if str_ip in {"169.254.169.254", "169.254.169.253", "100.100.100.200", "fd00:ec2::254"}:
        return True, "cloud metadata service"

    return False, ""


def check_local_allowlist(
    scheme: str,
    host: str,
    port: int,
    ip: ipaddress.IPv4Address | ipaddress.IPv6Address | None = None,
) -> bool:
    """Check server-side static allowlist for local agents.

    Default disabled. Configured strictly via MAPR_A2A_ALLOW_LOCALHOST and
    MAPR_A2A_LOCAL_ALLOWLIST / MAPR_SSRF_ALLOWLIST.
    NEVER permits cloud metadata or arbitrary private networks.
    """
    allow_localhost = os.environ.get("MAPR_A2A_ALLOW_LOCALHOST", "").lower() in ("true", "1", "yes")
    if not allow_localhost:
        return False

    is_loopback_host = host.lower() in ("localhost", "localhost.localdomain", "127.0.0.1", "::1")
    if ip is not None and not ip.is_loopback:
        return False
    if not is_loopback_host and ip is None:
        return False

    raw_allowlist = os.environ.get("MAPR_A2A_LOCAL_ALLOWLIST") or os.environ.get("MAPR_SSRF_ALLOWLIST") or ""
    if not raw_allowlist.strip():
        return False

    entries = [e.strip() for e in raw_allowlist.split(",") if e.strip()]
    for entry in entries:
        try:
            if "://" in entry:
                parsed_entry = urlsplit(entry)
                e_scheme = parsed_entry.scheme.lower()
                e_host = parsed_entry.hostname.lower() if parsed_entry.hostname else ""
                e_port = parsed_entry.port or (443 if e_scheme == "https" else 80)
            else:
                e_scheme = scheme.lower()
                parts = entry.split(":")
                e_host = parts[0].strip("[]").lower()
                e_port = int(parts[1]) if len(parts) > 1 else 80
        except Exception:
            continue

        # Invariant: Never allow cloud metadata in allowlist under any circumstance
        if e_host in CLOUD_METADATA_HOSTNAMES or e_host in {
            "169.254.169.254", "169.254.169.253", "100.100.100.200", "fd00:ec2::254"
        }:
            continue

        # Scheme must strictly match allowlist entry scheme
        if e_scheme != scheme.lower():
            continue

        # Verify entry host is strictly loopback
        try:
            raw_bytes = socket.inet_aton(e_host)
            entry_ip = ipaddress.IPv4Address(raw_bytes)
            if not entry_ip.is_loopback:
                continue
        except OSError:
            try:
                entry_ip = ipaddress.ip_address(e_host)
                if not entry_ip.is_loopback:
                    continue
            except ValueError:
                if e_host not in ("localhost", "localhost.localdomain"):
                    continue

        if e_port == port:
            if e_host == host.lower() or (e_host in ("localhost", "127.0.0.1", "::1") and is_loopback_host):
                return True

    return False


def _parse_obfuscated_ipv4(host: str) -> ipaddress.IPv4Address | None:
    """Detect and parse standard or obfuscated IPv4 formats.

    Catches hex (0x7f000001, 0x7f.1), octal (0177.0.0.1), decimal dword (2130706433),
    shortened notation (127.1), and dotted segment variations.
    """
    try:
        raw_bytes = socket.inet_aton(host)
        # inet_aton must have produced 4 bytes
        if len(raw_bytes) == 4:
            return ipaddress.IPv4Address(raw_bytes)
    except OSError:
        pass
    return None


def validate_agent_card_url(card_url: str) -> ValidatedTarget:
    """Validate an Agent Card URL against the SSRF safety policy.

    Returns a ValidatedTarget with resolved and verified IP pinning info.
    Raises SSRFValidationError on any violation. Exception messages are sanitized
    and never include credentials or secret tokens.
    """
    if not isinstance(card_url, str):
        raise SSRFValidationError("Card URL must be a string")

    card_url = card_url.strip()
    if not card_url:
        raise SSRFValidationError("Card URL cannot be empty")

    # Reject non-http(s) schemes immediately
    if not (card_url.startswith("http://") or card_url.startswith("https://")):
        raise SSRFValidationError("Scheme must be http or https")

    try:
        parsed = urlsplit(card_url)
    except Exception as exc:
        raise SSRFValidationError("Malformed URL") from exc

    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        raise SSRFValidationError("Scheme must be http or https")

    # Reject userinfo (credentials in URL) without reflecting them
    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
        raise SSRFValidationError("Userinfo (username/password) is not allowed in card URL")

    raw_host = parsed.hostname
    if not raw_host:
        raise SSRFValidationError("Invalid or missing host in card URL")

    # Strip IPv6 brackets
    host = raw_host.strip("[]").strip()
    if not host or len(host) > 253:
        raise SSRFValidationError("Invalid host in card URL")

    port = parsed.port
    if port is None:
        port = 443 if scheme == "https" else 80
    elif not (1 <= port <= 65535):
        raise SSRFValidationError("Port must be between 1 and 65535")

    base_path = parsed.path or ""
    if parsed.query:
        base_path = f"{base_path}?{parsed.query}"

    # Check for direct cloud metadata hostnames
    if host.lower() in CLOUD_METADATA_HOSTNAMES:
        raise SSRFValidationError("Access to cloud metadata hostnames is forbidden")

    # Check if host is an IP literal or obfuscated IP
    parsed_ip: ipaddress.IPv4Address | ipaddress.IPv6Address | None = None
    is_ipv6 = False

    # Try IPv6
    try:
        parsed_ip = ipaddress.IPv6Address(host)
        is_ipv6 = True
    except ValueError:
        # Try IPv4 / obfuscated IPv4
        parsed_ip = _parse_obfuscated_ipv4(host)

    if parsed_ip is not None:
        # Host is an IP literal
        if check_local_allowlist(scheme, host, port, parsed_ip):
            return ValidatedTarget(
                scheme=scheme,
                original_host=host,
                port=port,
                pinned_ip=str(parsed_ip),
                is_ipv6=is_ipv6,
                base_path=base_path,
                is_allowlisted_local=True,
            )

        disallowed, reason = is_disallowed_ip(parsed_ip)
        if disallowed:
            raise SSRFValidationError(f"Target IP address is disallowed ({reason})")

        return ValidatedTarget(
            scheme=scheme,
            original_host=host,
            port=port,
            pinned_ip=str(parsed_ip),
            is_ipv6=is_ipv6,
            base_path=base_path,
            is_allowlisted_local=False,
        )

    # Host is a hostname (domain name)
    # Check for localhost / loopback domains
    if host.lower() in ("localhost", "localhost.localdomain") or host.lower().endswith(".localhost"):
        if check_local_allowlist(scheme, host, port):
            return ValidatedTarget(
                scheme=scheme,
                original_host=host,
                port=port,
                pinned_ip="127.0.0.1",
                is_ipv6=False,
                base_path=base_path,
                is_allowlisted_local=True,
            )
        raise SSRFValidationError(f"Access to local host {host} is forbidden")

    # Check forbidden internal suffixes
    if any(host.lower().endswith(suffix) for suffix in FORBIDDEN_HOST_SUFFIXES):
        raise SSRFValidationError(f"Access to internal domain suffix is forbidden: {host}")

    # DNS Resolution — validate all resolved IP addresses fail-closed
    try:
        addrinfo = socket.getaddrinfo(host, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise SSRFValidationError(f"DNS resolution failed for {host}") from exc
    except Exception as exc:
        raise SSRFValidationError(f"DNS resolution error for {host}") from exc

    if not addrinfo:
        raise SSRFValidationError(f"No DNS records found for {host}")

    verified_ips: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for item in addrinfo:
        sockaddr = item[4]
        ip_str = sockaddr[0]
        try:
            resolved_ip = ipaddress.ip_address(ip_str)
        except ValueError as exc:
            raise SSRFValidationError(f"Invalid resolved IP address: {ip_str}") from exc

        disallowed, reason = is_disallowed_ip(resolved_ip)
        if disallowed:
            # Reject immediately if ANY resolved record is internal/disallowed (prevents DNS rebinding / mixed records)
            raise SSRFValidationError(f"Host {host} resolves to disallowed address ({reason})")

        verified_ips.append(resolved_ip)

    if not verified_ips:
        raise SSRFValidationError(f"No valid public IP addresses resolved for {host}")

    # Pin to the first verified IP
    chosen_ip = verified_ips[0]
    return ValidatedTarget(
        scheme=scheme,
        original_host=host,
        port=port,
        pinned_ip=str(chosen_ip),
        is_ipv6=isinstance(chosen_ip, ipaddress.IPv6Address),
        base_path=base_path,
        is_allowlisted_local=False,
    )


def _is_ipv6_literal(host: str) -> bool:
    """Return True if host string is an IPv6 address literal."""
    clean = host.strip("[]").strip()
    try:
        ip = ipaddress.ip_address(clean)
        return isinstance(ip, ipaddress.IPv6Address)
    except ValueError:
        return False


def create_pinned_transport(
    pinned_ip: str,
    port: int,
    original_host: str,
    scheme: str,
) -> httpx.AsyncBaseTransport | None:
    """Extension hook for tests to inject custom transports.

    By default returns None, directing httpx.AsyncClient to use its default transport
    with the target pinned URL, Host header, and SNI extension.
    """
    return None


def build_pinned_request(
    target: ValidatedTarget,
    probe_path: str = "",
) -> tuple[str, dict[str, str], dict[str, str]]:
    """Build the outbound request parameters with pinned IP, Host header, and TLS SNI."""
    if probe_path:
        if not probe_path.startswith("/"):
            probe_path = "/" + probe_path
        base = target.base_path.rstrip("/")
        full_path = f"{base}{probe_path}" if base else probe_path
    else:
        full_path = target.base_path if target.base_path else "/"

    ip_formatted = f"[{target.pinned_ip}]" if target.is_ipv6 else target.pinned_ip
    pinned_url = f"{target.scheme}://{ip_formatted}:{target.port}{full_path}"

    is_default_port = (target.scheme == "http" and target.port == 80) or (
        target.scheme == "https" and target.port == 443
    )
    # Host header brackets are strictly for IPv6 address literals, never for DNS hostnames
    is_ipv6_host = _is_ipv6_literal(target.original_host)
    host_for_header = (
        f"[{target.original_host.strip('[]')}]"
        if is_ipv6_host
        else target.original_host
    )
    host_header = host_for_header if is_default_port else f"{host_for_header}:{target.port}"

    headers = {"Host": host_header}
    extensions: dict[str, str] = {}
    if target.scheme == "https":
        extensions["sni_hostname"] = target.original_host

    return pinned_url, headers, extensions


async def safe_probe_agent_url(
    target: ValidatedTarget,
    probe_path: str,
    timeout: float = 5.0,
) -> httpx.Response:
    """Execute a safe, pinned outbound GET probe against an agent endpoint.

    - Bounded timeout (<= 5s)
    - trust_env=False (ignores environment proxies)
    - follow_redirects=False (disallows untrusted redirects)
    - Host and SNI pinned to original host
    - Socket connects strictly to pre-verified pinned IP
    """
    pinned_url, headers, extensions = build_pinned_request(target, probe_path)
    transport = create_pinned_transport(
        target.pinned_ip, target.port, target.original_host, target.scheme
    )
    timeout_val = min(max(timeout, 0.1), 5.0)

    async with httpx.AsyncClient(
        transport=transport,
        trust_env=False,
        follow_redirects=False,
        timeout=timeout_val,
    ) as client:
        return await client.get(pinned_url, headers=headers, extensions=extensions)


async def safe_agent_http_request(
    base_url: str,
    suffix: str = "",
    *,
    method: str = "GET",
    json_body: dict | list | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 5.0,
    connect_timeout: float | None = None,
    read_timeout: float | None = None,
) -> httpx.Response:
    """Execute a safe, pinned outbound HTTP request for Agent Card discovery or JSON-RPC.

    Security & transport policy enforced on every invocation:
    1. Validates base_url via validate_agent_card_url (rejects loopback, private RFC 1918,
       link-local, cloud metadata, multicast, reserved, obfuscated IP, userinfo, non-HTTP schemes).
    2. Fail-closed DNS validation: checks all resolved records against SSRF rules to prevent DNS rebinding.
    3. Socket pinned to verified IP with Host header and TLS SNI matching original host.
    4. trust_env=False: ignores HTTP_PROXY, HTTPS_PROXY, ALL_PROXY.
    5. follow_redirects=False: never follows 30x redirects automatically.
    6. Timeouts strictly bounded:
       - connect_timeout <= 5.0s (default min(timeout, 5.0))
       - read_timeout <= 60.0s for long-running tasks, default <= 5.0s for GET.

    Args:
        base_url: Target base URL (e.g. 'https://agent.example.com' or 'https://agent.example.com/a2a').
        suffix: Path suffix to append (e.g. '/rpc' or '/.well-known/agent-card.json').
        method: HTTP method ('GET', 'POST', etc.).
        json_body: Optional JSON payload for POST/RPC requests.
        headers: Optional extra headers to include (Host will always be managed).
        timeout: General timeout fallback (seconds).
        connect_timeout: Specific connect timeout (clamped to [0.1, 5.0]).
        read_timeout: Specific read timeout (clamped to [0.1, 60.0]).

    Returns:
        httpx.Response from the pre-verified endpoint.
    """
    method_upper = method.upper()

    # Re-validate target URL on every call (prevent TOCTOU / unverified endpoints)
    target = validate_agent_card_url(base_url)

    # Build pinned URL, Host header, and TLS SNI extension
    pinned_url, pinned_headers, extensions = build_pinned_request(target, suffix)

    # Assemble headers: preserve caller headers while strictly enforcing pinned Host
    req_headers: dict[str, str] = dict(headers) if headers else {}
    req_headers["Host"] = pinned_headers["Host"]
    if json_body is not None:
        has_content_type = any(k.lower() == "content-type" for k in req_headers)
        if not has_content_type:
            req_headers["Content-Type"] = "application/json"

    # Enforce strict bounded timeouts
    if connect_timeout is not None:
        conn_to = min(max(float(connect_timeout), 0.1), 5.0)
    else:
        conn_to = min(max(float(timeout), 0.1), 5.0)

    if read_timeout is not None:
        rd_to = min(max(float(read_timeout), 0.1), 60.0)
    elif method_upper == "POST":
        rd_to = 60.0 if timeout == 5.0 else min(max(float(timeout), 0.1), 60.0)
    else:
        rd_to = min(max(float(timeout), 0.1), 5.0)

    httpx_timeout = httpx.Timeout(
        connect=conn_to,
        read=rd_to,
        write=min(rd_to, 60.0),
        pool=conn_to,
    )

    transport = create_pinned_transport(
        target.pinned_ip, target.port, target.original_host, target.scheme
    )

    async with httpx.AsyncClient(
        transport=transport,
        trust_env=False,
        follow_redirects=False,
        timeout=httpx_timeout,
    ) as client:
        return await client.request(
            method=method_upper,
            url=pinned_url,
            headers=req_headers,
            json=json_body,
            extensions=extensions,
        )


from contextlib import asynccontextmanager


@asynccontextmanager
async def safe_agent_http_stream(
    base_url: str, suffix: str = '', *, method: str = 'GET',
    headers: dict[str, str] | None = None, json_body: dict | None = None,
):
    """Streaming counterpart with identical DNS pinning and TLS trust boundary.

    Response and socket lifetime are owned by this context, including cancellation.
    Never connect to the original hostname after validation.
    """
    target = validate_agent_card_url(base_url)
    pinned_url, pinned_headers, extensions = build_pinned_request(target, suffix)
    request_headers = {k:v for k,v in (headers or {}).items() if k.lower() != 'host'}
    request_headers.update(pinned_headers)
    transport = create_pinned_transport(target.pinned_ip, target.port, target.original_host, target.scheme)
    async with httpx.AsyncClient(
        transport=transport, trust_env=False, follow_redirects=False,
        timeout=httpx.Timeout(connect=5.0, read=30.0, write=30.0, pool=5.0),
    ) as client:
        async with client.stream(method, pinned_url, headers=request_headers,
                                 extensions=extensions, json=json_body) as response:
            if response.is_redirect:
                raise SSRFValidationError('Agent redirects are forbidden')
            response.raise_for_status()
            if 'text/event-stream' not in response.headers.get('content-type', ''):
                raise SSRFValidationError('Agent did not return an event stream')
            yield response
