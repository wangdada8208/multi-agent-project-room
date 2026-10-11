"""Commit-consistent room message counters and per-connection presence leases.

Apply only during a separately authorized maintenance window (writers stopped).
Historical messages are already committed; backfill preserves display order.
Revision ID: e50c20261011
Revises: d40c20261010
"""
from alembic import op
import sqlalchemy as sa

revision = "e50c20261011"
down_revision = "d40c20261010"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    room_columns = {c["name"] for c in sa.inspect(bind).get_columns("rooms")}
    message_columns = {c["name"] for c in sa.inspect(bind).get_columns("messages")}
    if "message_seq" not in room_columns:
        op.add_column("rooms", sa.Column("message_seq", sa.BigInteger(), nullable=False, server_default="0"))
    if "room_seq" not in message_columns:
        op.add_column("messages", sa.Column("room_seq", sa.BigInteger(), nullable=False, server_default="0"))
        op.execute(sa.text('''WITH ranked AS (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY created_at, id) AS seq FROM messages
        ) UPDATE messages SET room_seq = (SELECT seq FROM ranked WHERE ranked.id = messages.id)'''))
        op.execute(sa.text('''UPDATE rooms SET message_seq = COALESCE(
            (SELECT MAX(room_seq) FROM messages WHERE messages.room_id = rooms.id), 0)'''))
    if "client_message_id" not in message_columns:
        op.add_column("messages", sa.Column("client_message_id", sa.String(128), nullable=True))
    indexes = {idx["name"] for idx in sa.inspect(bind).get_indexes("messages")}
    constraints = {c["name"] for c in sa.inspect(bind).get_unique_constraints("messages")}
    if "uq_message_room_seq" not in indexes | constraints:
        op.create_index("uq_message_room_seq", "messages", ["room_id", "room_seq"], unique=True)
    if "uq_message_client_key" not in indexes | constraints:
        op.create_index("uq_message_client_key", "messages", ["room_id", "sender_id", "client_message_id"], unique=True)
    if "room_presences" not in sa.inspect(bind).get_table_names():
        op.create_table("room_presences",
            sa.Column("connection_id", sa.String(36), primary_key=True),
            sa.Column("room_id", sa.String(36), sa.ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False),
            sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("hub_id", sa.String(36), nullable=False),
            sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("lease_until", sa.DateTime(timezone=True), nullable=False))
        op.create_index("ix_presence_room_user", "room_presences", ["room_id", "user_id"])
        op.create_index("ix_presence_expiry", "room_presences", ["lease_until"])
        op.create_index("ix_room_presences_hub_id", "room_presences", ["hub_id"])


def downgrade():
    raise RuntimeError("No destructive downgrade: restore a reviewed backup in a maintenance window")
