"""Agent ownership and one-time binding; finite additive DDL, no data backfill.

Revision ID: a10c20261010
Revises: f9a1c2d3e4b5
"""
from alembic import op
import sqlalchemy as sa

revision = "a10c20261010"
down_revision = "f9a1c2d3e4b5"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("owner_user_id", sa.String(36), nullable=True))
        batch.add_column(sa.Column("owner_bound_at", sa.DateTime(timezone=True), nullable=True))
        batch.create_foreign_key("fk_users_owner_user_id_users", "users", ["owner_user_id"], ["id"])
        batch.create_index("ix_users_owner_user_id", ["owner_user_id"])
    with op.batch_alter_table("agent_card_records") as batch:
        batch.add_column(sa.Column("agent_user_id", sa.String(36), nullable=True))
        batch.create_foreign_key("fk_agent_card_records_agent_user_id_users", "users", ["agent_user_id"], ["id"])
        batch.create_index("ix_agent_card_records_agent_user_id", ["agent_user_id"])
    op.create_table(
        "agent_binding_invites",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("token_salt", sa.String(32), nullable=False),
        sa.Column("issuer_user_id", sa.String(36), nullable=False),
        sa.Column("target_agent_user_id", sa.String(36), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("claimed_agent_user_id", sa.String(36), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("token_hash", name="uq_agent_binding_invites_token_hash"),
        sa.ForeignKeyConstraint(["issuer_user_id"], ["users.id"], name="fk_agent_binding_invites_issuer"),
        sa.ForeignKeyConstraint(["target_agent_user_id"], ["users.id"], name="fk_agent_binding_invites_target"),
        sa.ForeignKeyConstraint(["claimed_agent_user_id"], ["users.id"], name="fk_agent_binding_invites_claimed"),
    )
    op.create_index("ix_agent_binding_invites_issuer_user_id", "agent_binding_invites", ["issuer_user_id"])
    op.create_index("ix_agent_binding_invites_expires_at", "agent_binding_invites", ["expires_at"])


def downgrade():
    # Destructive: only automatically exercised in a synthetic migration fixture.
    op.drop_table("agent_binding_invites")
    with op.batch_alter_table("agent_card_records") as batch:
        batch.drop_index("ix_agent_card_records_agent_user_id")
        batch.drop_constraint("fk_agent_card_records_agent_user_id_users", type_="foreignkey")
        batch.drop_column("agent_user_id")
    with op.batch_alter_table("users") as batch:
        batch.drop_index("ix_users_owner_user_id")
        batch.drop_constraint("fk_users_owner_user_id_users", type_="foreignkey")
        batch.drop_column("owner_bound_at")
        batch.drop_column("owner_user_id")
