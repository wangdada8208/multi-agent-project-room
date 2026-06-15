# **Demo**

This demo is a small first slice of the Multi-Agent Project Room.

It implements:

- FastAPI app entrypoint
- `GET /health`
- Room list API
- Message history API
- WebSocket room chat at `/ws/chat/{room_id}`
- A browser demo page at `/`
- In-memory room and message storage

It intentionally does not implement PostgreSQL yet.

The real MVP should replace the in-memory `RoomStore` with SQLAlchemy models, async sessions, and Alembic migrations.

------

# **Run**

```bash
cd "/Users/moxiao/Desktop/AI 协作项目"
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
./scripts/start.sh
```

Open:

```text
http://127.0.0.1:8000
```

Health check:

```text
http://127.0.0.1:8000/health
```

------

# **Try**

Open the demo page in two browser windows.

Send a message from one window.

The other window should receive it in real time through WebSocket.

Change the sender type from `Human` to `Agent` to simulate an agent participant.
