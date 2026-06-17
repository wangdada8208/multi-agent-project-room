"""add auth fields and task links

Revision ID: b4e8c7a92f10
Revises: 9e8f7d6c5b4a
Create Date: 2026-06-17 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa

revision = "b4e8c7a92f10"
down_revision = "9e8f7d6c5b4a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("password_hash", sa.String(length=256), nullable=True))
    op.add_column("users", sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("a2a_tasks", sa.Column("room_id", sa.String(length=36), nullable=True))
    op.add_column("a2a_tasks", sa.Column("source_message_id", sa.String(length=36), nullable=True))
    op.add_column("a2a_tasks", sa.Column("approval_id", sa.String(length=36), nullable=True))
    op.create_index("ix_a2a_tasks_room_id", "a2a_tasks", ["room_id"])
    op.create_foreign_key("fk_a2a_tasks_room_id_rooms", "a2a_tasks", "rooms", ["room_id"], ["id"])
    op.create_foreign_key("fk_a2a_tasks_source_message_id_messages", "a2a_tasks", "messages", ["source_message_id"], ["id"])
    op.create_foreign_key("fk_a2a_tasks_approval_id_approvals", "a2a_tasks", "approvals", ["approval_id"], ["id"])


def downgrade() -> None:
    op.drop_constraint("fk_a2a_tasks_approval_id_approvals", "a2a_tasks", type_="foreignkey")
    op.drop_constraint("fk_a2a_tasks_source_message_id_messages", "a2a_tasks", type_="foreignkey")
    op.drop_constraint("fk_a2a_tasks_room_id_rooms", "a2a_tasks", type_="foreignkey")
    op.drop_index("ix_a2a_tasks_room_id", table_name="a2a_tasks")
    op.drop_column("a2a_tasks", "approval_id")
    op.drop_column("a2a_tasks", "source_message_id")
    op.drop_column("a2a_tasks", "room_id")
    op.drop_column("users", "last_seen_at")
    op.drop_column("users", "password_hash")
