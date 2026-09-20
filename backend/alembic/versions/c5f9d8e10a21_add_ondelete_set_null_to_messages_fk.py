"""add ondelete set null to messages foreign keys

Revision ID: c5f9d8e10a21
Revises: b4e8c7a92f10
Create Date: 2026-09-20 22:30:00.000000
"""

from alembic import op

revision = "c5f9d8e10a21"
down_revision = "b4e8c7a92f10"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Update fk_a2a_tasks_source_message_id_messages
    op.drop_constraint("fk_a2a_tasks_source_message_id_messages", "a2a_tasks", type_="foreignkey")
    op.create_foreign_key(
        "fk_a2a_tasks_source_message_id_messages",
        "a2a_tasks",
        "messages",
        ["source_message_id"],
        ["id"],
        ondelete="SET NULL",
    )
    # 2. Update messages_parent_id_fkey
    op.drop_constraint("messages_parent_id_fkey", "messages", type_="foreignkey")
    op.create_foreign_key(
        "messages_parent_id_fkey",
        "messages",
        "messages",
        ["parent_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("messages_parent_id_fkey", "messages", type_="foreignkey")
    op.create_foreign_key(
        "messages_parent_id_fkey",
        "messages",
        "messages",
        ["parent_id"],
        ["id"],
    )
    op.drop_constraint("fk_a2a_tasks_source_message_id_messages", "a2a_tasks", type_="foreignkey")
    op.create_foreign_key(
        "fk_a2a_tasks_source_message_id_messages",
        "a2a_tasks",
        "messages",
        ["source_message_id"],
        ["id"],
    )
