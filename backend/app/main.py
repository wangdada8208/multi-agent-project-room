"""Multi-Agent Project Room — FastAPI application entrypoint."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.gateway.routes import router as gateway_router
from app.api.rooms import router as rooms_router
from app.chat.routes import router as chat_router
from app.a2a.server import router as a2a_router
from app.approval.routes import router as approval_router
from app.chat.ws_handler import handle_chat

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle."""
    yield


app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    lifespan=lifespan,
)

# ── Middleware ─────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Global exception handler ───────────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error", "detail": str(exc)},
    )


# ── Routes ────────────────────────────────────────────
app.include_router(gateway_router)    # GET /health
app.include_router(rooms_router)      # /api/v1/rooms
app.include_router(chat_router)       # /api/v1/rooms/{id}/messages
app.include_router(a2a_router)        # /a2a (JSON-RPC + Agent Card)
app.include_router(approval_router)   # /api/v1/approvals

# ── WebSocket ──────────────────────────────────────────
app.add_api_websocket_route("/ws/chat/{room_id}", handle_chat)
