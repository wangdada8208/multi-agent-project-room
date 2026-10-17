"""Agent registry service."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.identity import (
    canonical_identity,
    comparison_identity,
    expand_casefold_candidates,
)

from app.models.agent_card import AgentCardRecord
from app.models.user import User
from app.a2a.url_policy import validate_agent_card_url

logger = logging.getLogger(__name__)

# Punctuation that comparison_identity folds to a single separator, and the
# characters a pre-filter variant may use in its place.
_SEPARATOR_CHARS = ("_", "-", ".", "·", "・")
_MAX_VARIANT_POSITIONS = 6
_MAX_VARIANT_GROUPS = 32


def _enum_punctuation_variants(name: str) -> set[str]:
    """Enumerate spellings that differ only by which separators are used.

    Every separator position is rewritten to the same character, so all
    combinations (`a_b-c`, `a-b_c`, `a-b-c`, `a_b_c`, ...) are covered with at
    most one candidate per separator character. This is only a SQL pre-filter;
    the authoritative comparison is `comparison_identity`.
    """
    folded = name.casefold()
    if not any(ch in _SEPARATOR_CHARS for ch in folded):
        return set()
    return {folded.translate({ord(ch): repl for ch in _SEPARATOR_CHARS}) for repl in _SEPARATOR_CHARS}


async def find_username_matches(db: AsyncSession, username: str) -> list[User]:
    """Find all existing user records matching the given username under Unicode casefold.

    Uses `User.normalized_username` to query directly via the indexed normalized key,
    providing complete Unicode casefold equivalence class coverage (including θ/ϑ,
    ß/ss/ẞ, ligatures, sigma variants, and arbitrary mixed casing) without full
    table scans. Also includes expand_casefold_candidates(username) for backward
    compatibility with unmigrated legacy rows.

    Never returns a row whose canonical identity differs from the input.

    Identity is decided by `comparison_identity`, which treats the punctuation
    account names may contain (`_`, `-`, `.`) as one separator, so
    `race_x_bot` and `race_x-bot` are the same person. The stricter SQL filter
    below is only a pre-filter; the final verdict is made in Python and can
    never be looser than the pre-filter, because the substitute separator is
    itself allowed by the username charset.
    """
    key = comparison_identity(username)
    if not key:
        return []

    candidates = expand_casefold_candidates(username)
    if not candidates:
        return []

    stripped = username.strip()
    if not stripped:
        return []

    # Pre-filter: punctuation variants are enumerated in Python so the query
    # stays index-backed. One representative normalization per punctuation form
    # is enough; the exact verdict is the Python check below.
    prefilter: set[str] = set(candidates)
    for variant in _enum_punctuation_variants(stripped):
        prefilter.add(variant)
        prefilter.update(expand_casefold_candidates(variant))

    stmt = select(User).where(
        or_(
            User.normalized_username == canonical_identity(username),
            User.username.in_(prefilter),
        )
    )
    result = await db.execute(stmt)
    return [
        user
        for user in result.scalars().all()
        if comparison_identity(user.username) == key
    ]


async def authorize_agent_registration(db: AsyncSession, user: User, name: str) -> str:
    """Require a real, unambiguous agent account; display names confer no rights."""
    stored_user = await db.get(User, user.id, populate_existing=True) if user is not None else None
    if stored_user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if stored_user.user_type != "agent":
        raise HTTPException(status_code=403, detail="Agent account required")
    canonical = canonical_identity(stored_user.username)
    # The claimed name must be the account itself under the same comparison
    # identity used for registration, so `race_x-bot` cannot impersonate the
    # account registered as `race_x_bot`.
    if not isinstance(name, str) or comparison_identity(name) != comparison_identity(stored_user.username):
        raise HTTPException(status_code=403, detail="Agent name must match authenticated username")
    matches = await find_username_matches(db, stored_user.username)
    if len(matches) != 1 or matches[0].id != stored_user.id:
        raise HTTPException(status_code=403, detail="Ambiguous agent identity")
    return canonical


def validate_registration_url(name: str, url: str) -> None:
    """Allow only the caller's local marker or a policy-verified HTTP(S) URL."""
    if url == f"local://{name}":
        return
    try:
        validate_agent_card_url(url)
    except ValueError:
        # Never reflect URLs, credentials, queries, or policy exception text.
        raise HTTPException(status_code=400, detail="Invalid or disallowed agent URL") from None


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
    agent_user_id: str | None = None,
) -> dict:
    """Create or update an agent registration by name."""
    if agent_user_id is not None:
        actor = await db.get(User, agent_user_id, populate_existing=True)
        await authorize_agent_registration(db, actor, name)
    result = await db.execute(
        select(AgentCardRecord).where(AgentCardRecord.agent_name == name)
    )
    record = result.scalars().first()
    now = datetime.now(timezone.utc)

    if record is None:
        record = AgentCardRecord(
            agent_user_id=agent_user_id,
            agent_name=name,
            agent_card_url=url,
            capabilities=capabilities or [],
            skills=skills or [],
            is_active=True,
            last_seen_at=now,
        )
        db.add(record)
    else:
        if agent_user_id is not None:
            from sqlalchemy import update
            linked = await db.execute(update(AgentCardRecord).where(
                AgentCardRecord.id == record.id,
                (AgentCardRecord.agent_user_id.is_(None)) | (AgentCardRecord.agent_user_id == agent_user_id),
            ).values(agent_user_id=agent_user_id).execution_options(synchronize_session=False))
            if linked.rowcount != 1:
                await db.rollback()
                raise HTTPException(status_code=403, detail="Agent registry identity conflict")
        record.agent_card_url = url
        record.capabilities = capabilities or record.capabilities or []
        record.skills = skills or record.skills or []
        record.is_active = True
        record.last_seen_at = now

    await db.commit()
    await db.refresh(record)
    logger.info("agent registered name=%s id=%s", name, record.id)
    return _agent_to_dict(record)


async def list_agents(db: AsyncSession) -> list[dict]:
    result = await db.execute(
        select(AgentCardRecord).order_by(
            AgentCardRecord.is_active.desc(),
            AgentCardRecord.last_seen_at.desc().nullslast(),
            AgentCardRecord.created_at.desc(),
        )
    )
    agents = []
    seen_names = set()
    for record in result.scalars().all():
        key = record.agent_name.lower()
        if key in seen_names:
            continue
        seen_names.add(key)
        agents.append(_agent_to_dict(record))
    return agents


async def get_agent(db: AsyncSession, agent_id: str) -> dict | None:
    record = await db.get(AgentCardRecord, agent_id)
    return _agent_to_dict(record) if record else None
