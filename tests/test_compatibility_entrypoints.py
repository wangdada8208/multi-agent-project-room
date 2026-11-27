"""Exercise the shipped Python compatibility commands without connecting to a Hub."""

from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize(("script", "flags"), [
    ("local_agent_adapter.py", ("--server", "--room", "--auth-token", "--command")),
    ("agent_gateway.py", ("--server", "--room-id", "--backend", "--command")),
    ("trusted_runner.py", ("--room-id", "--token", "--tls-ca-bundle", "--tls-cert-fingerprint")),
])
def test_shipped_compatibility_command_help(script, flags):
    result = subprocess.run(
        [sys.executable, str(ROOT / script), "--help"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )

    for flag in flags:
        assert flag in result.stdout.split() or f"{flag}," in result.stdout.split()
