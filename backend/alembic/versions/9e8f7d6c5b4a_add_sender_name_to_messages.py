"""add sender_name to messages

Revision ID: 9e8f7d6c5b4a
Revises: 7c2d4f9a1b20
Create Date: 2026-06-16 20:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "9e8f7d6c5b4a"
down_revision: Union[str, Sequence[str], None] = "7c2d4f9a1b20"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("sender_name", sa.String(128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messages", "sender_name")
