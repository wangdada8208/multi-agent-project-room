"""create room_invites table

Revision ID: f9a1c2d3e4b5
Revises: e8f2b1c93a40
Create Date: 2026-10-01 21:00:00.000000
"""

from alembic import op
import sqlalchemy as sa

revision = "f9a1c2d3e4b5"
down_revision = "e8f2b1c93a40"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "room_invites",
        sa.Column("token", sa.String(length=64), primary_key=True, nullable=False),
        sa.Column("room_id", sa.String(length=36), sa.ForeignKey("rooms.id"), nullable=False),
        sa.Column("created_by", sa.String(length=36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("proposed_scopes", sa.JSON(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("redeemed_by_address", sa.String(length=42), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_room_invites_room_id", "room_invites", ["room_id"])


def downgrade() -> None:
    op.drop_index("ix_room_invites_room_id", table_name="room_invites")
    op.drop_table("room_invites")
