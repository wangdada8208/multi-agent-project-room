from __future__ import annotations

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.app.api.rooms import router as rooms_router
from backend.app.config import get_settings
from backend.app.database import check_database_connection
from backend.app.services.room_store import room_store
from backend.app.ws.connection_manager import connection_manager


settings = get_settings()

app = FastAPI(title=settings.app_name)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(rooms_router)
app.mount("/static", StaticFiles(directory="backend/static"), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse("backend/static/index.html")


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "service": settings.app_name,
        "database": await check_database_connection(),
    }


@app.websocket("/ws/chat/{room_id}")
async def chat_websocket(websocket: WebSocket, room_id: str) -> None:
    if room_store.get_room(room_id) is None:
        await websocket.close(code=1008)
        return

    await connection_manager.connect(room_id, websocket)
    await connection_manager.broadcast(
        room_id,
        {"type": "system", "content": "A participant joined the room."},
    )

    try:
        while True:
            payload = await websocket.receive_json()

            if payload.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            if payload.get("type") == "typing":
                await connection_manager.broadcast(
                    room_id,
                    {"type": "typing", "sender_id": payload.get("sender_id", "anonymous")},
                )
                continue

            content = str(payload.get("content", "")).strip()
            if not content:
                await websocket.send_json({"type": "error", "message": "content is required"})
                continue

            message = room_store.add_message(
                room_id=room_id,
                sender_id=str(payload.get("sender_id", "human-demo")),
                sender_type=payload.get("sender_type", "human"),
                content=content,
                msg_type=payload.get("msg_type", "text"),
            )
            await connection_manager.broadcast(
                room_id,
                {"type": "message", "message": message.to_dict()},
            )
    except WebSocketDisconnect:
        connection_manager.disconnect(room_id, websocket)
        await connection_manager.broadcast(
            room_id,
            {"type": "system", "content": "A participant left the room."},
        )
