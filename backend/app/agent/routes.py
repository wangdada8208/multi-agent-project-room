"""Agent REST API."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import service as agent_service
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.user import User

router = APIRouter(prefix="/api/v1/agents", tags=["agents"])


class RegisterAgentRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    url: str = Field(default="", max_length=512)
    capabilities: list[str] = Field(default_factory=list)
    skills: list[dict] = Field(default_factory=list)


@router.post("/register")
async def register_agent(
    payload: RegisterAgentRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    name = await agent_service.authorize_agent_registration(db, user, payload.name)
    url = payload.url or f"local://{name}"
    agent_service.validate_registration_url(name, url)
    agent = await agent_service.register_agent(
        db=db,
        agent_user_id=user.id,
        name=name,
        url=url,
        capabilities=payload.capabilities,
        skills=payload.skills,
    )
    return {"agent": agent}


@router.get("")
async def list_agents(db: AsyncSession = Depends(get_db)) -> dict:
    return {"agents": await agent_service.list_agents(db)}


@router.get("/{agent_id}")
async def get_agent(agent_id: str, db: AsyncSession = Depends(get_db)) -> dict:
    agent = await agent_service.get_agent(db, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    return {"agent": agent}
