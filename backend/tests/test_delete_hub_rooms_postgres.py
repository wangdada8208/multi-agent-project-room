from scripts.delete_hub_rooms_postgres import select_user_hub_room_ids


def test_selects_user_hub_rooms_only():
    rows = [
        ("old-room", "hub"),
        ("_agent_codex", "hub"),
        ("new-room", "xmtp"),
    ]
    assert select_user_hub_room_ids(rows) == ["old-room"]
