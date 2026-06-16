"""Agent registry service."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_card import AgentCardRecord


def _agent_to_dict(record: AgentCardRecord) -> dict:
    skills = record.skills or []
    capabilities = record.capabilities or []
    if not capabilities and skills:
        capabilities = [
            skill.get("id") or skill.get("name")
            for skill in skills
            if isinstance(skill, dict) and (skill.get("id") or skill.get("name"))
        ]

    return {
        "id": record.id,
        "name": record.agent_name,
        "url": record.agent_card_url,
        "status": "online" if record.is_active else "offline",
        "capabilities": capabilities,
        "skills": skills,
        "last_seen_at": record.last_seen_at.isoformat() if record.last_seen_at else None,
        "created_at": record.created_at.isoformat() if record.created_at else None,
    }


async def register_agent(
    db: AsyncSession,
    name: str,
    url: str,
    capabilities: list[str] | None = None,
    skills: list[dict] | None = None,
) -> dict:
    """Create or update an agent registration by name."""
    result = await db.execute(
        select(AgentCardRecord).where(AgentCardRecord.agent_name == name)
    )
    record = result.scalars().first()
    now = datetime.now(timezone.utc)

    if record is None:
        record = AgentCardRecord(
            agent_name=name,
            agent_card_url=url,
            capabilities=capabilities or [],
            skills=skills or [],
            is_active=True,
            last_seen_at=now,
        )
        db.add(record)
    else:
        record.agent_card_url = url
        record.capabilities = capabilities or record.capabilities or []
        record.skills = skills or record.skills or []
        record.is_active = True
        record.last_seen_at = now

    await db.commit()
    await db.refresh(record)
    return _agent_to_dict(record)


async def list_agents(db: AsyncSession) -> list[dict]:
    result = await db.execute(
        select(AgentCardRecord).order_by(
            AgentCardRecord.is_active.desc(),
            AgentCardRecord.last_seen_at.desc().nullslast(),
            AgentCardRecord.created_at.desc(),
        )
    )
    return [_agent_to_dict(record) for record in result.scalars().all()]


async def get_agent(db: AsyncSession, agent_id: str) -> dict | None:
    record = await db.get(AgentCardRecord, agent_id)
    return _agent_to_dict(record) if record else None
