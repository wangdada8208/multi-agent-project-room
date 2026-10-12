"""Comprehensive security & performance tests for Agent identity uniqueness,
Unicode casefold normalization, and index-backed candidate queries (Audit Group C).
"""

from __future__ import annotations

from unittest.mock import patch
import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.identity import (
    canonical_identity,
    canonical_slug,
    expand_casefold_candidates,
)
from app.agent.service import (
    authorize_agent_registration,
    find_username_matches,
)
from app.models.user import User


# =====================================================================
# 1. Canonical Identity and Slug Normalization
# =====================================================================


def test_canonical_identity_normalization():
    # Whitespace stripping and lowercase folding
    assert canonical_identity("  Agent_007  ") == "agent_007"
    assert canonical_identity("ALICE") == "alice"

    # German sharp S (Eszett) expands to 'ss'
    assert canonical_identity("groß") == "gross"
    assert canonical_identity("GROSS") == "gross"
    assert canonical_identity("GROẞ") == "gross"

    # Greek final sigma vs standard sigma (ς -> σ)
    assert canonical_identity("Ὀδυσσεύς") == "ὀδυσσεύσ"

    # Ligatures expand to multi-character ASCII
    assert canonical_identity("oﬃce") == "office"
    assert canonical_identity("ﬂower") == "flower"
    assert canonical_identity("ﬁle") == "file"
    assert canonical_identity("eﬀect") == "effect"

    # Edge cases
    assert canonical_identity("") == ""
    assert canonical_identity("   ") == ""
    assert canonical_identity(None) == ""  # type: ignore[arg-type]


def test_canonical_slug_normalization():
    # Whitespace collapsing to underscores
    assert canonical_slug("Agent Alpha") == "agent_alpha"
    assert canonical_slug("  Agent   Alpha  \t\n  ") == "agent_alpha"
    assert canonical_slug("groß agent") == "gross_agent"
    assert canonical_slug("oﬃce bot") == "office_bot"

    # Edge cases
    assert canonical_slug("") == ""
    assert canonical_slug("   ") == ""
    assert canonical_slug(None) == ""  # type: ignore[arg-type]


# =====================================================================
# 2. Candidate Expansion Coverage & Bounds
# =====================================================================


def test_expand_casefold_candidates_coverage_and_bounds():
    # For 'gross', candidates must include exact, casefold, and sharp S variants
    gross_candidates = expand_casefold_candidates("gross")
    assert "gross" in gross_candidates
    assert "groß" in gross_candidates
    assert "GROSS" in gross_candidates
    assert "GROẞ" in gross_candidates
    assert "Groß" in gross_candidates
    assert len(gross_candidates) <= 64

    # For 'groß', candidates must also include 'gross' variants
    eszett_candidates = expand_casefold_candidates("groß")
    assert "groß" in eszett_candidates
    assert "gross" in eszett_candidates
    assert "GROSS" in eszett_candidates
    assert "GROẞ" in eszett_candidates
    assert len(eszett_candidates) <= 64

    # For ligatures (e.g. 'office')
    office_candidates = expand_casefold_candidates("office")
    assert "office" in office_candidates
    assert "oﬃce" in office_candidates
    assert "OFFICE" in office_candidates
    assert len(office_candidates) <= 64

    # Edge cases
    assert expand_casefold_candidates("") == set()
    assert expand_casefold_candidates("   ") == {"   "}
    assert expand_casefold_candidates(None) == set()  # type: ignore[arg-type]


# =====================================================================
# 3. Symmetric Ambiguity Detection (gross vs groß)
# =====================================================================


@pytest.mark.asyncio
async def test_symmetric_ambiguity_detection_for_coexisting_gross_and_eszett(db: AsyncSession):
    # Seed historical coexisting accounts
    user_ascii = User(
        username="gross",
        display_name="ASCII Gross",
        password_hash="hash1",
        user_type="agent",
    )
    user_unicode = User(
        username="groß",
        display_name="Unicode Groß",
        password_hash="hash2",
        user_type="agent",
    )
    db.add(user_ascii)
    db.add(user_unicode)
    await db.commit()

    # Querying with 'gross' must find BOTH accounts symmetrically
    matches_from_ascii = await find_username_matches(db, "gross")
    assert len(matches_from_ascii) == 2
    matched_names_ascii = {u.username for u in matches_from_ascii}
    assert matched_names_ascii == {"gross", "groß"}

    # Querying with 'groß' must find BOTH accounts symmetrically
    matches_from_unicode = await find_username_matches(db, "groß")
    assert len(matches_from_unicode) == 2
    matched_names_unicode = {u.username for u in matches_from_unicode}
    assert matched_names_unicode == {"gross", "groß"}

    # Uppercase variations must also find both
    matches_upper_ascii = await find_username_matches(db, "GROSS")
    assert len(matches_upper_ascii) == 2

    matches_upper_unicode = await find_username_matches(db, "GROẞ")
    assert len(matches_upper_unicode) == 2

    # authorize_agent_registration must reject BOTH as ambiguous
    with pytest.raises(HTTPException) as exc_info_ascii:
        await authorize_agent_registration(db, user_ascii, "gross")
    assert exc_info_ascii.value.status_code == 403
    assert exc_info_ascii.value.detail == "Ambiguous agent identity"

    with pytest.raises(HTTPException) as exc_info_unicode:
        await authorize_agent_registration(db, user_unicode, "groß")
    assert exc_info_unicode.value.status_code == 403
    assert exc_info_unicode.value.detail == "Ambiguous agent identity"


# =====================================================================
# 4. Elimination of Full Table Scans for Non-Existent Usernames
# =====================================================================


@pytest.mark.asyncio
async def test_nonexistent_username_returns_empty_without_full_table_scan(db: AsyncSession):
    # Seed arbitrary users
    for i in range(5):
        db.add(
            User(
                username=f"existing_user_{i}",
                display_name=f"User {i}",
                password_hash="hash",
                user_type="human",
            )
        )
    await db.commit()

    original_execute = db.execute
    executed_statements = []

    async def execute_spy(statement, *args, **kwargs):
        executed_statements.append(str(statement))
        return await original_execute(statement, *args, **kwargs)

    with patch.object(db, "execute", side_effect=execute_spy):
        matches = await find_username_matches(db, "nonexistent_user_999")
        assert matches == []

    # Exactly 1 query was executed (IN :candidates), never a second full table scan
    assert len(executed_statements) == 1
    sql = executed_statements[0]
    # Verify the SQL contains WHERE User.username IN (...)
    assert "users.username IN (" in sql
    # Ensure it was NOT an unconstrained "SELECT users... FROM users" without WHERE
    assert "WHERE" in sql


# =====================================================================
# 5. Single Identity Resolution Across Variants
# =====================================================================


@pytest.mark.asyncio
async def test_single_identity_resolution_across_variants(db: AsyncSession):
    agent_user = User(
        username="Agent_Alpha",
        display_name="Alpha Agent",
        password_hash="hash",
        user_type="agent",
    )
    db.add(agent_user)
    await db.commit()

    # Exact, lowercase, uppercase, and trimmed lookups all resolve to the single agent
    for variant in ["Agent_Alpha", "agent_alpha", "AGENT_ALPHA", "  Agent_Alpha  "]:
        matches = await find_username_matches(db, variant)
        assert len(matches) == 1
        assert matches[0].id == agent_user.id
        assert matches[0].username == "Agent_Alpha"

    # Registration succeeds and returns canonical identity
    canonical = await authorize_agent_registration(db, agent_user, "agent_alpha")
    assert canonical == "agent_alpha"


# =====================================================================
# 6. Ligature and Special Character Resolution
# =====================================================================


@pytest.mark.asyncio
async def test_ligature_resolution(db: AsyncSession):
    # User registered with unicode ligature 'ffi'
    ligature_user = User(
        username="oﬃce_bot",
        display_name="Office Bot",
        password_hash="hash",
        user_type="agent",
    )
    db.add(ligature_user)
    await db.commit()

    # Query with ASCII 'office_bot' must find the ligature user
    matches = await find_username_matches(db, "office_bot")
    assert len(matches) == 1
    assert matches[0].id == ligature_user.id

    # Query with uppercase ASCII 'OFFICE_BOT'
    matches_upper = await find_username_matches(db, "OFFICE_BOT")
    assert len(matches_upper) == 1
    assert matches_upper[0].id == ligature_user.id


# =====================================================================
# 7. Registration Collision Prevention via Auth Routes
# =====================================================================


@pytest.mark.asyncio
async def test_registration_collision_prevention(client: AsyncClient, db: AsyncSession):
    # Seed historical account directly with 'groß'
    historical_user = User(
        username="groß",
        display_name="Historical Eszett User",
        password_hash="hash",
        user_type="human",
    )
    db.add(historical_user)
    await db.commit()

    # Attempt to register 'gross' (ASCII) -> must be rejected with 409 Conflict
    resp2 = await client.post(
        "/api/v1/auth/register",
        json={
            "username": "gross",
            "password": "Password123!",
            "display_name": "ASCII Gross",
        },
    )
    assert resp2.status_code == 409
    assert "Username already exists" in resp2.json()["detail"]

    # Attempt to register 'GROSS' -> must also be rejected with 409 Conflict
    resp3 = await client.post(
        "/api/v1/auth/register",
        json={
            "username": "GROSS",
            "password": "Password123!",
            "display_name": "Uppercase Gross",
        },
    )
    assert resp3.status_code == 409
    assert "Username already exists" in resp3.json()["detail"]


# =====================================================================
# 8. authorize_agent_registration Edge Cases
# =====================================================================


@pytest.mark.asyncio
async def test_authorize_agent_registration_edge_cases(db: AsyncSession):
    # 1. Missing user -> 401
    with pytest.raises(HTTPException) as exc1:
        await authorize_agent_registration(db, None, "test")  # type: ignore[arg-type]
    assert exc1.value.status_code == 401
    assert exc1.value.detail == "Authentication required"

    # 2. Human user -> 403
    human_user = User(
        username="human_user",
        display_name="Human",
        password_hash="hash",
        user_type="human",
    )
    db.add(human_user)
    await db.commit()

    with pytest.raises(HTTPException) as exc2:
        await authorize_agent_registration(db, human_user, "human_user")
    assert exc2.value.status_code == 403
    assert exc2.value.detail == "Agent account required"

    # 3. Name mismatch -> 403
    agent_user = User(
        username="agent_bob",
        display_name="Agent Bob",
        password_hash="hash",
        user_type="agent",
    )
    db.add(agent_user)
    await db.commit()

    with pytest.raises(HTTPException) as exc3:
        await authorize_agent_registration(db, agent_user, "agent_alice")
    assert exc3.value.status_code == 403
    assert exc3.value.detail == "Agent name must match authenticated username"
