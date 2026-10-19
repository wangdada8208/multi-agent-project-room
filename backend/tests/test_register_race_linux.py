"""Audit round 4, H3: concurrent registration must not create duplicate identities.

``race_x_bot`` and ``race_x-bot`` normalise to different keys, yet they are the
same person spelled two ways. Before the fix, the only defence was an
application-level check-then-insert, so two simultaneous requests both saw "no
match" and both inserted. The durable fix is the UNIQUE index
``ux_users_comparison_username`` on ``users.comparison_username``
(see docs/verification/2026-10-17-高危修复单.md).

Note on the column name: the unique constraint is deliberately *not* on
``users.normalized_username``. That column keeps the old comparison rule (case
folding only, punctuation preserved), so a UNIQUE index there would still allow
``race_x_bot`` and ``race_x-bot`` to coexist. The comparison key lives in
``users.comparison_username``, which folds the separators as well; the model
keeps both columns in sync from ``username``.

This gate is deliberately PostgreSQL-only: it needs a real unique constraint and
real concurrent sessions. On SQLite (the default fast test path) it is skipped
instead of pretending to pass.
"""
from __future__ import annotations

import asyncio
from uuid import uuid4

import pytest
from sqlalchemy import select

from conftest import engine as isolated_engine, test_session as sessions
from app.models.user import COMPARISON_USERNAME_INDEX, User

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(
        isolated_engine.dialect.name != "postgresql",
        reason="H3 race gate needs a real PostgreSQL unique constraint",
    ),
]


async def _register(client, username: str):
    return await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "password": "race-secret-123",
            "display_name": username,
        },
        headers={"X-Forwarded-For": "198.51.100.77"},
    )


async def _count_accounts(prefix: str) -> list[str]:
    async with sessions() as db:
        rows = await db.execute(
            select(User.username).where(User.normalized_username.like(f"{prefix}%"))
        )
        return [row[0] for row in rows.all()]


@pytest.mark.parametrize(
    "suffix_left,suffix_right",
    [
        ("_x_bot", "_x-bot"),   # separator spelling: the audit's reproducer
        ("_Race", "_race"),     # pure case variant
        ("_Stra\u00dfe", "_Strasse"),  # casefold equivalence (eszett -> ss)
    ],
)
async def test_concurrent_registration_creates_exactly_one_account(
    client, suffix_left, suffix_right
):
    prefix = f"race{uuid4().hex[:8]}"
    names = (prefix + suffix_left, prefix + suffix_right)

    responses = await asyncio.gather(*(_register(client, name) for name in names))
    codes = sorted(resp.status_code for resp in responses)

    # Exactly one account may win; the other request must be refused.
    assert codes == [200, 409], f"expected one 200 and one 409, got {codes}"
    accounts = await _count_accounts(prefix)
    assert len(accounts) == 1, f"duplicate accounts created: {accounts}"


async def test_concurrent_identical_username_creates_one_account(client):
    prefix = f"same{uuid4().hex[:8]}"
    name = f"{prefix}_bot"

    responses = await asyncio.gather(*(_register(client, name) for _ in range(4)))
    codes = sorted(resp.status_code for resp in responses)
    assert codes == [200, 409, 409, 409], f"expected 1 success, got {codes}"
    assert len(await _count_accounts(prefix)) == 1


async def test_comparison_username_has_unique_index():
    """The database itself — not only the application — must enforce uniqueness.

    Guards the *shape* of the constraint: a UNIQUE index must exist on
    ``users.comparison_username``, and it must be the one named
    ``ux_users_comparison_username`` (the same name migration i90c20261017
    creates in production).
    """
    async with isolated_engine.connect() as conn:
        from sqlalchemy import text

        result = await conn.execute(
            text(
                "SELECT indexname, indexdef FROM pg_indexes "
                "WHERE tablename = 'users'"
            )
        )
        rows = {row[0]: row[1] for row in result.all()}

    unique_comparison_indexes = {
        name: definition
        for name, definition in rows.items()
        if definition.upper().startswith("CREATE UNIQUE INDEX")
        and "comparison_username" in definition
    }
    assert unique_comparison_indexes, (
        "users.comparison_username has no UNIQUE index; concurrent registration "
        "can still create duplicate identities (audit H3). "
        f"indexes on users: {sorted(rows)}"
    )
    assert COMPARISON_USERNAME_INDEX in unique_comparison_indexes, (
        f"expected the unique index to be named {COMPARISON_USERNAME_INDEX!r} "
        f"(the name migration i90c20261017 creates), found "
        f"{sorted(unique_comparison_indexes)}"
    )
