"""create a2a_tasks and agent_card_records tables

Revision ID: 5a935249719e
Revises: 4023cb379d15
Create Date: 2026-06-15 14:16:46.215742

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '5a935249719e'
down_revision: Union[str, Sequence[str], None] = '4023cb379d15'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "a2a_tasks",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("source_agent", sa.String(64), nullable=False,
                  server_default="hub"),
        sa.Column("target_agent", sa.String(64), nullable=True),
        sa.Column("query", sa.Text(), nullable=False),
        sa.Column("status", sa.String(32), nullable=False,
                  server_default="submitted"),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True),
                  nullable=True),
    )
    op.create_table(
        "agent_card_records",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("agent_name", sa.String(128), nullable=False),
        sa.Column("agent_card_url", sa.String(512), nullable=False),
        sa.Column("capabilities", sa.JSON(), nullable=True),
        sa.Column("skills", sa.JSON(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False,
                  server_default="true"),
        sa.Column("last_seen_at", sa.DateTime(timezone=True),
                  nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("agent_card_records")
    op.drop_table("a2a_tasks")
