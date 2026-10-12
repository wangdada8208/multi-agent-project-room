"""Add is_active column to users table.

Revision ID: g70c20261012
Revises: f60c20261011
"""
from alembic import op
import sqlalchemy as sa

revision = 'g70c20261012'
down_revision = 'f60c20261011'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("users") as batch:
        batch.add_column(
            sa.Column(
                "is_active",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("true"),
            )
        )


def downgrade():
    with op.batch_alter_table("users") as batch:
        batch.drop_column("is_active")
