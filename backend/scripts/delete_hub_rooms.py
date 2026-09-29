from __future__ import annotations

import sqlite3
from pathlib import Path


def delete_hub_rooms(db_path: Path) -> dict:
    resolved_path = Path(db_path).resolve()
    if not resolved_path.exists():
        return {"deleted_rooms": 0, "database": resolved_path.name}

    conn = sqlite3.connect(resolved_path)
    cursor = conn.cursor()
    cursor.execute("PRAGMA foreign_keys = OFF;")

    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    existing_tables = {row[0] for row in cursor.fetchall()}

    if "rooms" not in existing_tables:
        conn.close()
        return {"deleted_rooms": 0, "database": resolved_path.name}

    cursor.execute("SELECT id FROM rooms WHERE transport = 'hub'")
    target_room_ids = [row[0] for row in cursor.fetchall() if not str(row[0]).startswith("_agent_")]

    if not target_room_ids:
        conn.close()
        return {"deleted_rooms": 0, "database": resolved_path.name}

    placeholders = ",".join("?" for _ in target_room_ids)

    if "messages" in existing_tables:
        cursor.execute(
            f"UPDATE messages SET parent_id = NULL WHERE parent_id IN (SELECT id FROM messages WHERE room_id IN ({placeholders}))",
            target_room_ids,
        )
        cursor.execute(f"DELETE FROM messages WHERE room_id IN ({placeholders})", target_room_ids)

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
            cursor.execute(f"DELETE FROM {table} WHERE room_id IN ({placeholders})", target_room_ids)

    cursor.execute(f"DELETE FROM rooms WHERE id IN ({placeholders})", target_room_ids)

    conn.commit()
    conn.close()

    return {
        "deleted_rooms": len(target_room_ids),
        "database": resolved_path.name,
    }


if __name__ == "__main__":
    candidates = [
        Path("agent_room.db"),
        Path("../agent_room.db"),
        Path(__file__).resolve().parents[2] / "agent_room.db",
    ]
    target_db = None
    for cand in candidates:
        if cand.is_file():
            target_db = cand
            break

    if target_db:
        result = delete_hub_rooms(target_db)
        print(result)
    else:
        print("agent_room.db not found, skipped.")
