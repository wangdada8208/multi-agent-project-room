"""m1: seat lifecycle, reusable invites, redemptions, room settings, XMTP nonces

Revision ID: l20c20261120
Revises: k10c20261118
Create Date: 2026-11-20

背景
----
m1 迁移（docs/项目计划 m1 批次，WP5/WP6/WP9 + 人类地址绑定的硬前置）：

* ``agent_seats``：``helper_id`` 改可空，新增 ``source``（'helper'|'invite'）
  与 ``paused_at``，让云端 Agent 通过可复用邀请自助入座；helper 席位保留
  原有 ``(helper_id, agent_key, room_id)`` 唯一约束，云端席位另用部分唯一
  索引 ``uq_agent_seat_invite`` 保证同一 Agent 用户在同一房间只有一席。
* ``room_invites``：多用途（``max_uses``/``use_count``）、逐次批准
  （``requires_approval``）、人类角色限制（``role`` 仅 member|viewer）与
  软吊销（``revoked_at``，审计行不再物理删除）。
* ``room_permissions``：新增经 EIP-191 验签绑定的 ``xmtp_address``，支撑
  「先出 XMTP 群、再删 Hub 行」的移除闭环。
* ``rooms``：``settings_json`` + ``settings_version``，保存模板与
  House Rules 建议等安全元数据（不含正文）。
* ``room_invite_redemptions``：逐次核销审计，记录人/地址/Agent/席位、
  状态机、决定者、TTL 与实际授予 scopes。
* ``xmtp_auth_nonces``：域名隔离、单次使用的 EIP-191 挑战 nonce，
  服务端行级原子核销，重启后不丢。

在 SQLite 上的注意
------------------
``conftest.py`` 的测试库用 ``Base.metadata.create_all`` 直接按模型建表。
本迁移全程使用 ``batch_alter_table`` + 跨库 ``sa.JSON()``，SQLite 与
PostgreSQL 都能执行。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "l20c20261120"
down_revision: Union[str, None] = "k10c20261118"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── agent_seats: cloud-agent seats + owner pause ──
    with op.batch_alter_table("agent_seats", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("source", sa.String(length=8), nullable=False, server_default="helper")
        )
        batch_op.add_column(sa.Column("paused_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.alter_column("helper_id", existing_type=sa.String(length=36), nullable=True)
        batch_op.create_check_constraint(
            "ck_agent_seats_source", "source IN ('helper','invite')"
        )
    op.create_index(
        "uq_agent_seat_invite",
        "agent_seats",
        ["room_id", "agent_user_id"],
        unique=True,
        postgresql_where=sa.text("helper_id IS NULL"),
        sqlite_where=sa.text("helper_id IS NULL"),
    )

    # ── room_invites: multi-use + approval + soft revoke ──
    with op.batch_alter_table("room_invites", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("max_uses", sa.Integer(), nullable=False, server_default="1")
        )
        batch_op.add_column(
            sa.Column("use_count", sa.Integer(), nullable=False, server_default="0")
        )
        batch_op.add_column(
            sa.Column("requires_approval", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.add_column(
            sa.Column("role", sa.String(length=16), nullable=False, server_default="member")
        )
        batch_op.add_column(sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.create_check_constraint(
            "ck_room_invites_role", "role IN ('member','viewer')"
        )
        batch_op.create_check_constraint(
            "ck_room_invites_uses", "use_count >= 0 AND use_count <= max_uses"
        )
    # H1: Backfill legacy single-use invites so previously redeemed rows never resurrect as open.
    op.execute(sa.text("UPDATE room_invites SET use_count = 1 WHERE used_at IS NOT NULL"))

    # ── room_permissions: verified XMTP address binding ──
    with op.batch_alter_table("room_permissions", schema=None) as batch_op:
        batch_op.add_column(sa.Column("xmtp_address", sa.String(length=42), nullable=True))
        batch_op.create_index("ix_room_permissions_xmtp", ["room_id", "xmtp_address"])

    # ── rooms: versioned safe metadata ──
    with op.batch_alter_table("rooms", schema=None) as batch_op:
        batch_op.add_column(sa.Column("settings_json", sa.JSON(), nullable=True))
        batch_op.add_column(
            sa.Column("settings_version", sa.Integer(), nullable=False, server_default="0")
        )

    # ── room_invite_redemptions: per-use audit ──
    op.create_table(
        "room_invite_redemptions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("redeemer_user_id", sa.String(length=36), nullable=True),
        sa.Column("redeemer_address", sa.String(length=42), nullable=True),
        sa.Column("agent_user_id", sa.String(length=36), nullable=True),
        sa.Column("seat_id", sa.String(length=36), nullable=True),
        sa.Column("approved_scopes", sa.JSON(), nullable=True),
        sa.Column("decided_by", sa.String(length=36), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deny_reason", sa.String(length=64), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["token"], ["room_invites.token"], name="fk_redemptions_token"
        ),
        sa.ForeignKeyConstraint(
            ["redeemer_user_id"], ["users.id"], name="fk_redemptions_redeemer_user"
        ),
        sa.ForeignKeyConstraint(
            ["agent_user_id"], ["users.id"], name="fk_redemptions_agent_user"
        ),
        sa.ForeignKeyConstraint(
            ["seat_id"], ["agent_seats.id"], name="fk_redemptions_seat"
        ),
        sa.ForeignKeyConstraint(
            ["decided_by"], ["users.id"], name="fk_redemptions_decided_by"
        ),
    )
    op.create_index(
        "uq_redemption_token_address",
        "room_invite_redemptions",
        ["token", "redeemer_address"],
        unique=True,
    )
    op.create_index(
        "uq_redemption_token_user_pending",
        "room_invite_redemptions",
        ["token", "redeemer_user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending' AND redeemer_user_id IS NOT NULL"),
        sqlite_where=sa.text("status = 'pending' AND redeemer_user_id IS NOT NULL"),
    )
    op.create_index(
        "ix_redemptions_token_status",
        "room_invite_redemptions",
        ["token", "status"],
    )

    # ── xmtp_auth_nonces: single-use EIP-191 challenges ──
    op.create_table(
        "xmtp_auth_nonces",
        sa.Column("nonce", sa.String(length=64), primary_key=True),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("resource", sa.String(length=128), nullable=False),
        sa.Column("address", sa.String(length=42), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_xmtp_auth_nonces_expires", "xmtp_auth_nonces", ["expires_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_xmtp_auth_nonces_expires", table_name="xmtp_auth_nonces")
    op.drop_table("xmtp_auth_nonces")

    op.drop_index("ix_redemptions_token_status", table_name="room_invite_redemptions")
    op.drop_index("uq_redemption_token_user_pending", table_name="room_invite_redemptions")
    op.drop_index("uq_redemption_token_address", table_name="room_invite_redemptions")
    op.drop_table("room_invite_redemptions")

    with op.batch_alter_table("rooms", schema=None) as batch_op:
        batch_op.drop_column("settings_version")
        batch_op.drop_column("settings_json")

    with op.batch_alter_table("room_permissions", schema=None) as batch_op:
        batch_op.drop_index("ix_room_permissions_xmtp")
        batch_op.drop_column("xmtp_address")

    with op.batch_alter_table("room_invites", schema=None) as batch_op:
        batch_op.drop_constraint("ck_room_invites_uses", type_="check")
        batch_op.drop_constraint("ck_room_invites_role", type_="check")
        batch_op.drop_column("revoked_at")
        batch_op.drop_column("role")
        batch_op.drop_column("requires_approval")
        batch_op.drop_column("use_count")
        batch_op.drop_column("max_uses")

    # Cloud seats cannot survive helper_id NOT NULL: remove them on downgrade.
    op.execute(sa.text("DELETE FROM agent_seats WHERE helper_id IS NULL"))
    op.drop_index("uq_agent_seat_invite", table_name="agent_seats")
    with op.batch_alter_table("agent_seats", schema=None) as batch_op:
        batch_op.drop_constraint("ck_agent_seats_source", type_="check")
        batch_op.drop_column("paused_at")
        batch_op.drop_column("source")
        batch_op.alter_column("helper_id", existing_type=sa.String(length=36), nullable=False)
