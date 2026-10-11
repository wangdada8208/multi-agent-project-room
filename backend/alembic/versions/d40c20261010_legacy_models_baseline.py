"""Formal baseline migration for historical ORM tables.

Covers 6 historical tables previously unmanaged by Alembic:
- room_permissions
- action_grants
- room_files
- room_templates
- room_share_tokens
- analytics_events

Safe and idempotent: checks existing tables before creating to prevent
duplicate table errors on databases where init_db() already ran.
Preserves all existing data. Downgrade is safe no-op to prevent
accidental data loss of pre-existing production state.

Revision ID: d40c20261010
Revises: c30c20261010
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "d40c20261010"
down_revision: Union[str, None] = "c30c20261010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    existing_tables = set(sa.inspect(bind).get_table_names()) if bind else set()

    # 1. room_permissions (role-based room access control)
    if "room_permissions" not in existing_tables:
        op.create_table(
            "room_permissions",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("room_id", sa.String(36), sa.ForeignKey("rooms.id"), nullable=False),
            sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("role", sa.String(16), nullable=False, server_default="member"),
            sa.Column("invited_by", sa.String(36), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("room_id", "user_id", name="uq_room_user"),
        )

    # 2. action_grants (bounded single-use action grants issued upon approval)
    if "action_grants" not in existing_tables:
        op.create_table(
            "action_grants",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("approval_id", sa.String(36), sa.ForeignKey("approvals.id", ondelete="CASCADE"), nullable=False),
            sa.Column("task_id", sa.String(36), nullable=True),
            sa.Column("room_id", sa.String(36), sa.ForeignKey("rooms.id"), nullable=False),
            sa.Column("granted_to_agent", sa.String(100), nullable=False),
            sa.Column("scope", sa.String(100), nullable=False),
            sa.Column("params_hash", sa.String(64), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_action_grants_approval_id", "action_grants", ["approval_id"])
        op.create_index("ix_action_grants_task_id", "action_grants", ["task_id"])
        op.create_index("ix_action_grants_room_id", "action_grants", ["room_id"])

    # 3. room_files (room uploaded file metadata)
    if "room_files" not in existing_tables:
        op.create_table(
            "room_files",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("room_id", sa.String(36), sa.ForeignKey("rooms.id"), nullable=False),
            sa.Column("filename", sa.String(255), nullable=False),
            sa.Column("stored_name", sa.String(255), nullable=False),
            sa.Column("size", sa.Integer(), nullable=False),
            sa.Column("uploaded_by", sa.String(64), nullable=False),
            sa.Column("uploaded_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("stored_name", name="uq_room_files_stored_name"),
        )
        op.create_index("ix_room_files_room_id", "room_files", ["room_id"])

    # 4. room_templates (preset collaboration scenarios)
    if "room_templates" not in existing_tables:
        op.create_table(
            "room_templates",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("key", sa.String(64), nullable=False),
            sa.Column("name", sa.String(128), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("icon", sa.String(16), nullable=False, server_default="🏠"),
            sa.Column("team_config_markdown", sa.Text(), nullable=True),
            sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("key", name="uq_room_templates_key"),
        )

    # 5. room_share_tokens (room public read-only link tokens)
    if "room_share_tokens" not in existing_tables:
        op.create_table(
            "room_share_tokens",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("room_id", sa.String(36), sa.ForeignKey("rooms.id"), nullable=False),
            sa.Column("token", sa.String(128), nullable=False),
            sa.Column("created_by", sa.String(36), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("token", name="uq_room_share_tokens_token"),
        )
        op.create_index("ix_room_share_tokens_room_id", "room_share_tokens", ["room_id"])

    # 6. analytics_events (product analytics events)
    if "analytics_events" not in existing_tables:
        op.create_table(
            "analytics_events",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("event_type", sa.String(64), nullable=False),
            sa.Column("user_id", sa.String(36), nullable=True),
            sa.Column("room_id", sa.String(36), nullable=True),
            sa.Column("metadata_json", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_analytics_room_type", "analytics_events", ["room_id", "event_type"])
        op.create_index("ix_analytics_user_time", "analytics_events", ["user_id", "created_at"])


def downgrade() -> None:
    # Protection: Never drop historical baseline tables on downgrade.
    # In production, these tables (room_permissions, action_grants, room_files,
    # room_templates, room_share_tokens, analytics_events) pre-date Alembic
    # versioning and contain vital production state. Preserving them guarantees
    # rollback and re-upgrade cycles never destroy existing production or tenant data.
    pass
