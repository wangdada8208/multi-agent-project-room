"""create knowledge docs table

Revision ID: 7c2d4f9a1b20
Revises: fda1d6ee3e5d
Create Date: 2026-06-16 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "7c2d4f9a1b20"
down_revision: Union[str, Sequence[str], None] = "fda1d6ee3e5d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "knowledge_docs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "room_id",
            sa.String(36),
            sa.ForeignKey("rooms.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("author_id", sa.String(36), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_knowledge_docs_room_updated", "knowledge_docs", ["room_id", "updated_at"])


def downgrade() -> None:
    op.drop_index("ix_knowledge_docs_room_updated", table_name="knowledge_docs")
    op.drop_table("knowledge_docs")
