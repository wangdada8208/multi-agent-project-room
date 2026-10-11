#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
export PYTHONPATH="$PWD/backend${PYTHONPATH:+:$PYTHONPATH}"
exec python3 -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 --ws websockets --ws-max-size 65536 --no-access-log
