"""Comprehensive security & performance tests for Agent identity uniqueness,
Unicode casefold normalization, and index-backed candidate queries (Audit Group C).
"""

from __future__ import annotations

import uuid
from unittest.mock import patch
import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import service
from app.agent.identity import (
    canonical_identity,
    canonical_slug,
    comparison_identity,
    expand_casefold_candidates,
    normalize_unicode_casefold,
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


# 比较键相同的「同一个人」的多种写法。迁移 i90 之前它们能在同一个库里共存，
# 迁移之后不可能：users.comparison_username 上的唯一索引会拒绝第二行，而迁移
# 脚本自己遇到重复数据也会直接报错退出（不删号、不合并）。
COLLIDING_IDENTITY_PAIRS = [
    ("gross", "groß"),              # 大小写折叠：ß -> ss
    ("agent-θ", "agent-ϑ"),          # θ / ϑ 同属一个 casefold 等价类
    ("agent-ß", "agent-SS"),         # ß / SS / ẞ
    ("agent-ﬃce", "agent-ffice"),    # 连字 ﬃ -> ffi
    ("race_x_bot", "race_x-bot"),    # 标点折叠：审计 H3 的原始复现
]


@pytest.mark.parametrize("first,second", COLLIDING_IDENTITY_PAIRS)
def test_colliding_pairs_share_one_comparison_identity(first, second):
    """先钉住口径：这几种写法确实被判为同一个人。"""
    assert comparison_identity(first) == comparison_identity(second)


@pytest.mark.asyncio
@pytest.mark.parametrize("first,second", COLLIDING_IDENTITY_PAIRS)
async def test_database_refuses_two_accounts_with_the_same_comparison_identity(
    db: AsyncSession, first, second
):
    """迁移后世界的权威断言：数据库自己拒绝第二个同比较键的账号。

    本章原先靠「先往库里塞两行重复身份，再看应用层怎么处理」来测歧义检测。
    i90 之后那个数据状态不可能再产生（迁移遇到重复会报错退出），所以数据层的
    不变量在这里被显式断言；应用层的判歧义分支由
    ``test_ambiguous_identity_is_refused_when_two_matches_exist`` 覆盖。
    改用例是语义正确的，不是为了让 CI 变绿。
    """
    db.add(User(username=first, display_name=f"first {first}", user_type="agent"))
    await db.commit()

    db.add(User(username=second, display_name=f"second {second}", user_type="agent"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    usernames = [row.username for row in (await db.execute(select(User))).scalars().all()]
    assert usernames == [first], f"同比较键的第二行不该落库，实际：{usernames}"


@pytest.mark.asyncio
@pytest.mark.parametrize("first,second", COLLIDING_IDENTITY_PAIRS)
async def test_ambiguous_identity_is_refused_when_two_matches_exist(
    db: AsyncSession, monkeypatch, first, second
):
    """纵深防御：只要匹配到两条，就必须 403，绝不任选一个。

    迁移后无法再制造「两行同比较键」的数据状态，所以直接把两条匹配记录交给
    ``authorize_agent_registration``。这样判歧义那条业务分支依然被测试证明过，
    而不是退化成死代码。
    """
    stored = User(username=first, display_name="stored agent", user_type="agent")
    db.add(stored)
    await db.commit()

    phantom = User(
        id=f"phantom-{uuid.uuid4().hex[:12]}",
        username=second,
        display_name="phantom duplicate",
        user_type="agent",
    )

    async def two_matches(_db, _username):
        return [stored, phantom]

    # authorize_agent_registration 在 app.agent.service 内按模块全局名查找，
    # 因此 patch 模块属性即可生效。
    monkeypatch.setattr(service, "find_username_matches", two_matches)

    with pytest.raises(HTTPException) as exc_info:
        await authorize_agent_registration(db, stored, first)
    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Ambiguous agent identity"


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


# =====================================================================
# 9. Full Unicode Casefold Equivalence & Collision Tests (Round 4)
# =====================================================================


def test_unicode_casefold_equivalence_classes():
    """Verify complete coverage of Unicode casefold equivalence classes.

    Tests:
    - Greek theta vs script theta (θ vs ϑ)
    - German sharp s vs SS vs uppercase ẞ (ß vs SS vs ẞ)
    - Ligatures (ﬁ vs fi, ﬃ vs ffi)
    - Greek sigma forms (Σ vs σ vs ς)
    - Mixed case and whitespace
    """
    # θ vs ϑ
    assert canonical_identity("agent-θ") == canonical_identity("agent-ϑ")
    assert canonical_slug("Agent-θ") == canonical_slug("Agent-ϑ")
    assert canonical_slug("Agent-θ") == "agent-θ"

    # ß vs SS vs ẞ
    assert canonical_identity("groß") == canonical_identity("GROSS")
    assert canonical_identity("groß") == canonical_identity("GROẞ")
    assert canonical_identity("groß") == "gross"
    assert canonical_slug("Groß-Agent") == canonical_slug("GROSS-AGENT")
    assert canonical_slug("Groß-Agent") == "gross-agent"

    # Ligatures: ﬁ (U+FB01) vs fi, ﬃ (U+FB03) vs ffi
    assert canonical_identity("oﬃce") == canonical_identity("office")
    assert canonical_identity("ﬁle-agent") == canonical_identity("file-agent")
    assert canonical_slug("Oﬃce-Bot") == canonical_slug("Office-Bot")
    assert canonical_slug("Oﬃce-Bot") == "office-bot"

    # Greek sigma forms: Σ vs σ vs ς
    assert canonical_identity("Ὀδυσσεύς") == canonical_identity("ὀδυσσεύσ")
    assert canonical_identity("Σ") == canonical_identity("σ")
    assert canonical_identity("σ") == canonical_identity("ς")


@pytest.mark.asyncio
async def test_registration_collision_unicode_theta(client: AsyncClient, db: AsyncSession):
    """Registration of agent-ϑ must be rejected when agent-θ exists."""
    resp1 = await client.post(
        "/api/v1/auth/register",
        json={
            "username": "agent-θ",
            "password": "Password123!",
            "display_name": "Theta Agent",
        },
    )
    assert resp1.status_code == 200

    # Attempt to register script theta variant -> 409 Conflict
    resp2 = await client.post(
        "/api/v1/auth/register",
        json={
            "username": "agent-ϑ",
            "password": "Password123!",
            "display_name": "Script Theta Agent",
        },
    )
    assert resp2.status_code == 409
    assert "Username already exists" in resp2.json()["detail"]


@pytest.mark.asyncio
async def test_registration_collision_ligatures(client: AsyncClient, db: AsyncSession):
    """Registration of ligature ﬁ variant must be rejected when fi exists."""
    resp1 = await client.post(
        "/api/v1/auth/register",
        json={
            "username": "file-agent",
            "password": "Password123!",
            "display_name": "File Agent",
        },
    )
    assert resp1.status_code == 200

    resp2 = await client.post(
        "/api/v1/auth/register",
        json={
            "username": "ﬁle-agent",
            "password": "Password123!",
            "display_name": "Ligature File Agent",
        },
    )
    assert resp2.status_code == 409
    assert "Username already exists" in resp2.json()["detail"]
