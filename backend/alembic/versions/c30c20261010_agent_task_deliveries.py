"""Persistent WS delivery metadata; no message bodies or backfill.
Revision ID: c30c20261010
Revises: b20c20261010
"""
from alembic import op
import sqlalchemy as sa
revision = "c30c20261010"
down_revision = "b20c20261010"
branch_labels = None
depends_on = None

def upgrade():
    op.create_table("agent_task_deliveries",
        sa.Column("delivery_id", sa.String(36), primary_key=True),
        sa.Column("task_id", sa.String(36), nullable=False),
        sa.Column("message_id", sa.String(36), nullable=False),
        sa.Column("agent_user_id", sa.String(36), nullable=False),
        sa.Column("target_room", sa.String(64), nullable=False),
        sa.Column("state", sa.String(24), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("lease_owner", sa.String(36), nullable=True),
        *[sa.Column(field, sa.DateTime(timezone=True), nullable=True) for field in
          ("ack_at", "lease_until", "delivered_at", "canceled_at")],
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["task_id"], ["a2a_tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["agent_user_id"], ["users.id"]),
        sa.UniqueConstraint("task_id", name="uq_agent_delivery_task"))
    op.create_index("ix_agent_task_deliveries_agent_user_id", "agent_task_deliveries", ["agent_user_id"])
    op.create_index("ix_agent_task_deliveries_state", "agent_task_deliveries", ["state"])

def downgrade():
    # Only synthetic fixtures; production rollback needs independent approval.
    op.drop_table("agent_task_deliveries")
