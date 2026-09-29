import sqlite3
from pathlib import Path

from scripts.delete_hub_rooms import delete_hub_rooms


def test_delete_hub_rooms_keeps_agent_channels(tmp_path: Path):
    db_path = tmp_path / "rooms.db"
    conn = sqlite3.connect(db_path)
    conn.execute("create table rooms (id text primary key, transport text)")
    conn.execute("create table messages (id text primary key, room_id text, content text, parent_id text)")
    conn.execute("insert into rooms values ('old-room', 'hub')")
    conn.execute("insert into rooms values ('_agent_codex', 'hub')")
    conn.execute("insert into rooms values ('new-room', 'xmtp')")
    conn.execute("insert into messages values ('m1', 'old-room', '旧正文', null)")
    conn.execute("insert into messages values ('m2', 'new-room', '新正文', null)")
    conn.commit()
    conn.close()

    summary = delete_hub_rooms(db_path)

    conn = sqlite3.connect(db_path)
    remaining = {row[0] for row in conn.execute("select id from rooms")}
    messages = {row[0] for row in conn.execute("select content from messages")}
    conn.close()
    assert remaining == {"_agent_codex", "new-room"}
    assert messages == {"新正文"}
    assert summary["deleted_rooms"] == 1
