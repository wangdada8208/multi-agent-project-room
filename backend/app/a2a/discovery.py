"""Agent Discovery — register, discover, and health-check agents."""

from datetime import datetime, timezone

import httpx
from sqlalchemy import select

from app.core.database import async_session
from app.models.agent_card import AgentCardRecord


class AgentDiscovery:
    """Agent registration and discovery service."""

    @staticmethod
    async def register(
        agent_name: str, card_url: str, capabilities: list[str] | None = None
    ) -> dict:
        """Register an agent. Fetches its Agent Card to verify connectivity."""
        # Verify the agent is reachable
        card_data = None
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(
                    f"{card_url.rstrip('/')}/.well-known/agent-card"
                )
                if resp.status_code == 200:
                    card_data = resp.json()
        except Exception:
            pass

        async with async_session() as db:
            record = AgentCardRecord(
                agent_name=agent_name,
                agent_card_url=card_url,
                capabilities=capabilities or [],
                skills=card_data.get("skills", []) if card_data else [],
                is_active=True,
            )
            db.add(record)
            await db.commit()
            await db.refresh(record)

        return {
            "id": record.id,
            "agent_name": agent_name,
            "card_url": card_url,
            "status": "registered",
        }

    @staticmethod
    async def list_available(capability: str | None = None) -> list[dict]:
        """List active agents, optionally filtered by capability."""
        async with async_session() as db:
            stmt = select(AgentCardRecord).where(
                AgentCardRecord.is_active == True
            )
            if capability:
                stmt = stmt.where(
                    AgentCardRecord.capabilities.contains([capability])
                )
            result = await db.execute(stmt)
            records = result.scalars().all()

        return [
            {
                "id": r.id,
                "name": r.agent_name,
                "url": r.agent_card_url,
                "capabilities": r.capabilities if r.capabilities else [],
                "last_seen": (
                    r.last_seen_at.isoformat() if r.last_seen_at else None
                ),
            }
            for r in records
        ]

    @staticmethod
    async def health_check() -> dict:
        """Check all registered agents. Marks unreachable ones as offline."""
        async with async_session() as db:
            result = await db.execute(
                select(AgentCardRecord).where(
                    AgentCardRecord.is_active == True
                )
            )
            records = result.scalars().all()
            online = 0
            offline = 0

            for record in records:
                try:
                    async with httpx.AsyncClient(timeout=3) as client:
                        resp = await client.get(
                            f"{record.agent_card_url.rstrip('/')}/health"
                        )
                        if resp.status_code == 200:
                            record.last_seen_at = datetime.now(timezone.utc)
                            online += 1
                        else:
                            record.is_active = False
                            offline += 1
                except Exception:
                    record.is_active = False
                    offline += 1

            await db.commit()

        return {"total": len(records), "online": online, "offline": offline}
