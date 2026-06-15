"""A2A JSON-RPC server — unified entry point for agent communication.

All A2A methods are routed through POST /a2a.
Agent Card is served at GET /a2a/.well-known/agent-card.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import get_settings
from app.a2a.agent_card import build_hub_card
from app.a2a import task_manager as tm
from app.a2a.discovery import AgentDiscovery
from app.chat import service as chat_service
from app.core.database import async_session

router = APIRouter(prefix="/a2a", tags=["a2a"])
settings = get_settings()


# ── Models ────────────────────────────────────────────


class JSONRPCRequest(BaseModel):
    jsonrpc: str = "2.0"
    method: str
    params: dict = {}
    id: str | int | None = None


class JSONRPCResponse(BaseModel):
    jsonrpc: str = "2.0"
    result: dict | None = None
    error: dict | None = None
    id: str | int | None = None


# ── Agent Card (discovery) ────────────────────────────


@router.get("/.well-known/agent-card")
async def get_agent_card():
    """A2A protocol standard — agent capability discovery endpoint."""
    return build_hub_card(settings.a2a_public_url).model_dump()


# ── JSON-RPC unified entry ────────────────────────────

METHODS: dict[str, callable] = {}


def rpc_method(name: str):
    """Decorator: register a JSON-RPC method handler."""
    def wrapper(fn):
        METHODS[name] = fn
        return fn
    return wrapper


@router.post("")
async def handle_jsonrpc(request: JSONRPCRequest):
    """Single JSON-RPC endpoint for all A2A methods."""
    handler = METHODS.get(request.method)
    if not handler:
        return JSONRPCResponse(
            error={"code": -32601, "message": f"Method not found: {request.method}"},
            id=request.id,
        )
    try:
        result = await handler(request.params)
        return JSONRPCResponse(result=result, id=request.id)
    except HTTPException:
        raise
    except Exception as e:
        return JSONRPCResponse(
            error={"code": -32000, "message": str(e)},
            id=request.id,
        )


# ── Method implementations ────────────────────────────


@rpc_method("tasks/send")
async def rpc_tasks_send(params: dict) -> dict:
    """Submit a task. Routes to target_agent if specified."""
    task_id = params.get("id")
    query = params.get("query", "")
    target = params.get("target_agent")

    if not query:
        raise HTTPException(status_code=400, detail="query is required")

    return await tm.submit_task(
        query=query,
        target_agent=target,
        task_id=task_id,
    )


@rpc_method("tasks/get")
async def rpc_tasks_get(params: dict) -> dict | None:
    """Get task status and result."""
    task_id = params.get("id")
    if not task_id:
        raise HTTPException(status_code=400, detail="id is required")
    task = await tm.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@rpc_method("tasks/cancel")
async def rpc_tasks_cancel(params: dict) -> dict:
    """Cancel a running task."""
    task_id = params.get("id")
    if not task_id:
        raise HTTPException(status_code=400, detail="id is required")
    return await tm.cancel_task(task_id)


@rpc_method("tasks/list")
async def rpc_tasks_list(params: dict) -> dict:
    """List tasks with optional status filter."""
    tasks = await tm.list_tasks(
        page=params.get("page", 1),
        limit=params.get("limit", 50),
        status=params.get("status"),
    )
    return {"tasks": tasks, "count": len(tasks)}


@rpc_method("message/send")
async def rpc_message_send(params: dict) -> dict:
    """Send a message into a chat room (A2A → Chat bridge)."""
    room_id = params.get("room_id")
    content = params.get("content", "")
    sender_id = params.get("sender_id", "a2a-hub")
    sender_type = params.get("sender_type", "system")
    msg_type = params.get("msg_type", "text")

    if not room_id or not content:
        raise HTTPException(status_code=400, detail="room_id and content are required")

    async with async_session() as db:
        message = await chat_service.save_message(
            db=db, room_id=room_id, sender_id=sender_id,
            sender_type=sender_type, content=content, msg_type=msg_type,
        )

    # Broadcast via WebSocket (connection_manager broadcasts independently
    # on the ws_handler side; this just persists the message)
    return {"status": "sent", "message_id": message.id}


@rpc_method("agent/list")
async def rpc_agent_list(params: dict) -> dict:
    """List registered agents."""
    agents = await AgentDiscovery.list_available(
        capability=params.get("capability")
    )
    return {"agents": agents}


@rpc_method("agent/register")
async def rpc_agent_register(params: dict) -> dict:
    """Register a new agent for discovery."""
    name = params.get("name", "")
    url = params.get("url", "")
    if not name or not url:
        raise HTTPException(status_code=400, detail="name and url are required")
    return await AgentDiscovery.register(name, url)
