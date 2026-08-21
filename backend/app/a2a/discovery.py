from __future__ import annotations
"""Agent Discovery — register, discover, and health-check agents."""

from datetime import datetime, timezone

import httpx
from sqlalchemy import select, delete

from app.core.database import async_session
from app.models.agent_card import AgentCardRecord


class AgentDiscovery:
    """Agent registration and discovery service."""

    @staticmethod
    async def register(
        agent_name: str, card_url: str, capabilities: list[str] | None = None
    ) -> dict:
        """Register or update an agent. Upserts by agent_name + card_url."""
        # Verify the agent is reachable
        card_data = None
        for probe_path in ("/.well-known/agent-card.json", "/a2a/.well-known/agent-card"):
            try:
                async with httpx.AsyncClient(timeout=5) as client:
                    resp = await client.get(f"{card_url.rstrip('/')}{probe_path}")
                    if resp.status_code == 200:
                        card_data = resp.json()
                        break
            except Exception:
                pass

        skills = card_data.get("skills", []) if card_data else []

        async with async_session() as db:
            # Check for existing record with same name + url
            stmt = select(AgentCardRecord).where(
                AgentCardRecord.agent_name == agent_name,
                AgentCardRecord.agent_card_url == card_url,
            )
            result = await db.execute(stmt)
            record = result.scalars().first()

            if record:
                # Update existing
                record.capabilities = capabilities or []
                record.skills = skills
                record.is_active = True
                record.last_seen_at = datetime.now(timezone.utc)
                status = "updated"
            else:
                # Deactivate any other records with same name but different URL
                old_stmt = select(AgentCardRecord).where(
                    AgentCardRecord.agent_name == agent_name,
                    AgentCardRecord.agent_card_url != card_url,
                    AgentCardRecord.is_active == True,
                )
                old_result = await db.execute(old_stmt)
                for old in old_result.scalars().all():
                    old.is_active = False

                # Create new
                record = AgentCardRecord(
                    agent_name=agent_name,
                    agent_card_url=card_url,
                    capabilities=capabilities or [],
                    skills=skills,
                    is_active=True,
                    last_seen_at=datetime.now(timezone.utc),
                )
                db.add(record)
                status = "registered"

            await db.commit()
            await db.refresh(record)

        return {
            "id": record.id,
            "agent_name": agent_name,
            "card_url": card_url,
            "status": status,
        }

    @staticmethod
    async def list_available(capability: str | None = None) -> list[dict]:
        """List active agents, optionally filtered by capability."""
        async with async_session() as db:
            stmt = select(AgentCardRecord).where(
                AgentCardRecord.is_active == True
            ).order_by(AgentCardRecord.agent_name, AgentCardRecord.last_seen_at.desc())
            if capability:
                stmt = stmt.where(
                    AgentCardRecord.capabilities.contains([capability])
                )
            result = await db.execute(stmt)
            all_records = result.scalars().all()
            
            # Deduplicate by name in Python (works across SQLite and PostgreSQL)
            seen: set[str] = set()
            records = []
            for rec in all_records:
                if rec.agent_name not in seen:
                    seen.add(rec.agent_name)
                    records.append(rec)

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
    async def cleanup_duplicates() -> dict:
        """Remove duplicate inactive registrations, keeping only the latest active per name."""
        async with async_session() as db:
            # Get all records ordered by last_seen desc
            stmt = select(AgentCardRecord).order_by(
                AgentCardRecord.agent_name,
                AgentCardRecord.last_seen_at.desc(),
                AgentCardRecord.id.desc(),
            )
            result = await db.execute(stmt)
            all_records = result.scalars().all()

            seen_names: set[str] = set()
            to_remove: list[str] = []

            for rec in all_records:
                key = rec.agent_name.lower()
                if rec.is_active and key not in seen_names:
                    seen_names.add(key)
                elif rec.is_active and key in seen_names:
                    # Duplicate active — deactivate
                    to_remove.append(rec.id)
                    rec.is_active = False
                elif not rec.is_active:
                    # Inactive duplicate — mark for deletion
                    to_remove.append(rec.id)

            if to_remove:
                await db.execute(
                    delete(AgentCardRecord).where(AgentCardRecord.id.in_(to_remove))
                )

            await db.commit()

        return {"removed": len(to_remove), "kept": len(seen_names)}

    @staticmethod
    async def health_check() -> dict:
        """Check all registered agents. Marks unreachable ones as offline."""
        async with async_session() as db:
            result = await db.execute(
                select(AgentCardRecord).where(AgentCardRecord.is_active == True)
            )
            records = result.scalars().all()
            online = 0
            offline = 0

            for record in records:
                alive = False
                for probe_path in ("/health", "/.well-known/agent-card.json"):
                    try:
                        async with httpx.AsyncClient(timeout=3) as client:
                            resp = await client.get(
                                f"{record.agent_card_url.rstrip('/')}{probe_path}"
                            )
                            if resp.status_code == 200:
                                alive = True
                                break
                    except Exception:
                        continue

                if alive:
                    record.last_seen_at = datetime.now(timezone.utc)
                    online += 1
                else:
                    record.is_active = False
                    offline += 1

            await db.commit()

        return {"total": len(records), "online": online, "offline": offline}
