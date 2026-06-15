"""create messages table

Revision ID: 4023cb379d15
Revises: 4282869a120f
Create Date: 2026-06-15 14:11:35.405581

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4023cb379d15'
down_revision: Union[str, Sequence[str], None] = '4282869a120f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "messages",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("room_id", sa.String(36), sa.ForeignKey("rooms.id"),
                  nullable=False, index=True),
        sa.Column("sender_id", sa.String(36), sa.ForeignKey("users.id"),
                  nullable=False),
        sa.Column("sender_type", sa.String(16), nullable=False,
                  server_default="human"),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("msg_type", sa.String(32), nullable=False,
                  server_default="text"),
        sa.Column("parent_id", sa.String(36),
                  sa.ForeignKey("messages.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False, index=True),
    )


def downgrade() -> None:
    op.drop_table("messages")
