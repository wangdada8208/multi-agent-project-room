"""Multi-Agent Project Room — FastAPI application entrypoint.

A2A Protocol v1.0 via official a2a-sdk.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.core.database import init_db, async_session
from app.chat.delivery_sweeper import DeliverySweeper
from app.chat.task_reconciler import TaskReconciler
from app.chat.room_synchronizer import RoomSynchronizer
from app.ws.connection_manager import connection_manager
from app.gateway.routes import router as gateway_router
from app.auth.routes import router as auth_router
from app.api.rooms import router as rooms_router
from app.chat.routes import router as chat_router
from app.a2a.server import legacy_router, mount_a2a
from app.a2a.routes import router as task_router
from app.approval.routes import router as approval_router
from app.agent.routes import router as agent_router
from app.knowledge.routes import router as knowledge_router
from app.repository.routes import router as repository_router
from app.files.routes import router as files_router
from app.api.search import router as search_router
from app.api.analytics import router as analytics_router
from app.api.permissions import router as permissions_router
from app.api.templates import router as templates_router
from app.api.agent_bindings import router as agent_bindings_router
from app.api.invites import router as invites_router
from app.chat.ws_handler import handle_chat

from app.a2a.sse_sweeper import SSEQuotaSweeper
from app.core.observability import install_redacting_filter

settings = get_settings()
logger = logging.getLogger(__name__)

# Ensure logging filters are installed immediately upon module import
install_redacting_filter()


class SafeHTTPErrorBoundary:
    """Keep SQL parameters and private exception text out of server tracebacks."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return
        started = finished = False
        async def tracked_send(frame):
            nonlocal started, finished
            if frame['type'] == 'http.response.start':
                started = True
            elif frame['type'] == 'http.response.body' and not frame.get('more_body', False):
                finished = True
            await send(frame)
        try:
            await self.app(scope, receive, tracked_send)
        except Exception:
            logger.warning('HTTP request failed; exception details suppressed')
            if not started:
                await JSONResponse({'error': 'Internal server error'}, status_code=500)(scope, receive, send)
            elif not finished:
                await send({'type': 'http.response.body', 'body': b'', 'more_body': False})


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle: create tables on startup."""
    install_redacting_filter()
    await init_db()
    # Lifespan runs in each worker, including servers that preload before fork.
    from app.a2a import http_protocol
    import uuid
    http_protocol.HUB_ID = str(uuid.uuid4())
    quota_sweeper = SSEQuotaSweeper(async_session)
    app.state.sse_quota_sweeper = quota_sweeper
    quota_sweeper.start()
    sweeper = DeliverySweeper(async_session)
    app.state.delivery_sweeper = sweeper
    sweeper.start()
    room_sync = RoomSynchronizer(async_session, connection_manager)
    app.state.room_synchronizer = room_sync
    room_sync.start()
    reconciler = TaskReconciler(async_session, connection_manager, settings.database_url, room_sync=room_sync)
    app.state.task_reconciler = reconciler
    reconciler.start()
    try:
        yield
    finally:
        await reconciler.stop()
        await room_sync.stop()
        await sweeper.stop()
        await quota_sweeper.stop()


app = FastAPI(
    title=settings.app_name,
    version="2.0.0",
    lifespan=lifespan,
)

# ── Middleware ─────────────────────────────────────────
app.add_middleware(SafeHTTPErrorBoundary)
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
        content={"error": "Internal server error"},
    )


# ── Routes ────────────────────────────────────────────
app.include_router(gateway_router)    # GET /health
app.include_router(auth_router)       # /api/v1/auth
app.include_router(rooms_router)      # /api/v1/rooms
app.include_router(invites_router)    # /api/v1/rooms/{id}/invites & /api/v1/invites
app.include_router(chat_router)       # /api/v1/rooms/{id}/messages
app.include_router(task_router)       # /api/v1/tasks
app.include_router(approval_router)   # /api/v1/approvals
app.include_router(agent_bindings_router)
app.include_router(agent_router)      # /api/v1/agents
app.include_router(knowledge_router)  # /api/v1/rooms/{id}/docs
app.include_router(repository_router) # /api/v1/rooms/{id}/git
app.include_router(files_router)     # /api/v1/rooms/{id}/files
app.include_router(search_router)    # /api/v1/rooms/{id}/messages/search
app.include_router(analytics_router) # /api/v1/analytics
app.include_router(permissions_router)  # /api/v1/rooms/{id}/permissions
app.include_router(templates_router)   # /api/v1/templates

# A2A v1.0 — official SDK protocol routes (Agent Card + JSON-RPC)
mount_a2a(app)

# A2A legacy — dialogue system + agent discovery RPC
app.include_router(legacy_router)     # /a2a/rpc (dialogue methods)

# ── WebSocket ──────────────────────────────────────────
app.add_api_websocket_route("/ws/chat/{room_id}", handle_chat)
