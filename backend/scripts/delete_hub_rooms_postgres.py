from __future__ import annotations

import asyncio
import os
import sys
from typing import Sequence


def select_user_hub_room_ids(rows: Sequence[tuple[str, str] | list[str]]) -> list[str]:
    selected: list[str] = []
    for row in rows:
        room_id, transport = row[0], row[1]
        if transport == "hub" and not str(room_id).startswith("_agent_"):
            selected.append(str(room_id))
    return selected


def is_postgres_url(url: str | None) -> bool:
    if not url:
        return False
    normalized = url.strip().lower()
    return normalized.startswith(("postgresql://", "postgres://", "postgresql+asyncpg://", "postgresql+psycopg://"))


async def async_delete_hub_rooms_postgres(database_url: str | None = None) -> dict:
    url = database_url or os.environ.get("DATABASE_URL") or os.environ.get("MAPR_DATABASE_URL")
    if not is_postgres_url(url):
        print("DATABASE_URL must be a valid PostgreSQL connection string. Aborting without action.")
        return {"deleted_rooms": 0, "status": "skipped_not_postgres"}

    assert url is not None
    import asyncpg

    clean_dsn = url.replace("postgresql+asyncpg://", "postgresql://").replace("postgresql+psycopg://", "postgresql://")
    conn = await asyncpg.connect(clean_dsn)

    try:
        tables_records = await conn.fetch(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
        )
        existing_tables = {r["table_name"] for r in tables_records}

        if "rooms" not in existing_tables:
            print("Table 'rooms' does not exist. No rooms to delete.")
            return {"deleted_rooms": 0, "status": "rooms_table_missing"}

        room_records = await conn.fetch("SELECT id, transport FROM rooms WHERE transport = 'hub'")
        rows = [(r["id"], r["transport"]) for r in room_records]
        target_room_ids = select_user_hub_room_ids(rows)

        if not target_room_ids:
            print("No user hub rooms found to delete. All agent channels and non-hub rooms are preserved.")
            return {"deleted_rooms": 0, "status": "no_targets"}

        print(f"Found {len(target_room_ids)} user hub room(s) to delete: {target_room_ids}")

        async with conn.transaction():
            if "messages" in existing_tables:
                await conn.execute(
                    "UPDATE messages SET parent_id = NULL WHERE parent_id IN ("
                    "SELECT id FROM messages WHERE room_id = ANY($1::text[])"
                    ")",
                    target_room_ids,
                )
                await conn.execute(
                    "DELETE FROM messages WHERE room_id = ANY($1::text[])",
                    target_room_ids,
                )

            child_tables = [
                "room_permissions",
                "room_files",
                "room_share_tokens",
                "knowledge_docs",
                "approvals",
                "action_grants",
                "a2a_tasks",
                "analytics_events",
            ]

            for table in child_tables:
                if table in existing_tables:
                    await conn.execute(
                        f"DELETE FROM {table} WHERE room_id = ANY($1::text[])",
                        target_room_ids,
                    )

            await conn.execute(
                "DELETE FROM rooms WHERE id = ANY($1::text[])",
                target_room_ids,
            )

        print(f"Successfully deleted {len(target_room_ids)} user hub room(s).")
        return {"deleted_rooms": len(target_room_ids), "status": "completed"}
    finally:
        await conn.close()


def delete_hub_rooms_postgres(database_url: str | None = None) -> dict:
    return asyncio.run(async_delete_hub_rooms_postgres(database_url))


if __name__ == "__main__":
    db_url = os.environ.get("DATABASE_URL") or os.environ.get("MAPR_DATABASE_URL")
    if not is_postgres_url(db_url):
        print("DATABASE_URL must be a valid PostgreSQL connection string.", file=sys.stderr)
        sys.exit(1)
    res = delete_hub_rooms_postgres(db_url)
    print(res)
