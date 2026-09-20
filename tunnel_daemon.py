#!/usr/bin/env python3
"""Tunnel Daemon — keeps SSH reverse tunnel alive with open stdin."""

import subprocess
import re
import sys

cmd = [
    "ssh", "-p", "443",
    "-o", "StrictHostKeyChecking=no",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=6",
    "-R0:localhost:5173",
    "a.pinggy.io"
]

proc = subprocess.Popen(
    cmd,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1
)

extracted = False
for _ in range(40):
    line = proc.stdout.readline()
    if not line:
        break
    match = re.search(r"https://[a-zA-Z0-9.-]+\.(?:pinggy\.net|pinggy-free\.link)", line)
    if match:
        url = match.group(0)
        with open("/tmp/live_tunnel.url", "w") as f:
            f.write(url.strip() + "\n")
        print(f"LIVE_URL: {url.strip()}", flush=True)
        extracted = True
        break

if not extracted:
    print("Failed to extract URL", flush=True)

# Keep stdin pipe alive forever so server never sees EOF
proc.wait()
