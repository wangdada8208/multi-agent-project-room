"""A2A task events audit log, context_id and atomic event_seq counter.

Revision ID: b20c20261010
Revises: a10c20261010
"""
from alembic import op
import sqlalchemy as sa

revision = "b20c20261010"
down_revision = "a10c20261010"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("a2a_tasks") as batch:
        batch.add_column(sa.Column("context_id", sa.String(36), nullable=True))
        batch.add_column(sa.Column("event_seq", sa.Integer(), nullable=False, server_default="0"))
        batch.create_index("ix_a2a_tasks_context_id", ["context_id"])

    op.create_table(
        "task_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("task_id", sa.String(36), nullable=False),
        sa.Column("event_seq", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(64), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["task_id"], ["a2a_tasks.id"], name="fk_task_events_task_id_a2a_tasks", ondelete="CASCADE"),
        sa.UniqueConstraint("task_id", "event_seq", name="uq_task_event_seq"),
    )
    op.create_index("ix_task_events_task_id", "task_events", ["task_id"])


def downgrade():
    op.drop_index("ix_task_events_task_id", table_name="task_events")
    op.drop_table("task_events")
    with op.batch_alter_table("a2a_tasks") as batch:
        batch.drop_index("ix_a2a_tasks_context_id")
        batch.drop_column("event_seq")
        batch.drop_column("context_id")
