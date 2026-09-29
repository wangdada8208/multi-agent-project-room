"""add room transport and xmtp_group_id

Revision ID: d7e1a9c04b22
Revises: c5f9d8e10a21
Create Date: 2026-09-22 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa

revision = "d7e1a9c04b22"
down_revision = "c5f9d8e10a21"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column("transport", sa.String(16), nullable=False, server_default="hub"),
    )
    op.add_column(
        "rooms",
        sa.Column("xmtp_group_id", sa.String(128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("rooms", "xmtp_group_id")
    op.drop_column("rooms", "transport")
