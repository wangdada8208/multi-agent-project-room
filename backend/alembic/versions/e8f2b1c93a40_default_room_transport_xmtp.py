"""default new room transport to xmtp

Revision ID: e8f2b1c93a40
Revises: d7e1a9c04b22
Create Date: 2026-09-23 02:45:00.000000
"""

from alembic import op
import sqlalchemy as sa

revision = "e8f2b1c93a40"
down_revision = "d7e1a9c04b22"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "rooms",
        "transport",
        existing_type=sa.String(length=16),
        server_default="xmtp",
    )


def downgrade() -> None:
    op.alter_column(
        "rooms",
        "transport",
        existing_type=sa.String(length=16),
        server_default="hub",
    )
