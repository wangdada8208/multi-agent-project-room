"""add helper onboarding tables (helper_devices / helper_codes / agent_seats)

Revision ID: j00c20261117
Revises: i90c20261017
Create Date: 2026-11-17

背景
----
一键接入 Agent 方案（docs/superpowers/plans/2026-11-17-一键接入Agent-总体方案.md，
2026-11-17 主人批准，决定项 D6）需要三张新表支撑 Hub 侧的配对与席位登记：

* ``helper_devices``：已配对的本机助手。只存 helper 令牌的加盐哈希与
  ``revoked_at``，令牌原文只在配对响应里出现一次。
* ``helper_codes``：人签发的一次性码，``kind`` 区分配对码（``pair``，10 分钟）
  与加入票据（``join``，2 分钟）。只存加盐哈希；``consumed_at`` 配合
  ``expires_at`` 用一条带条件的 UPDATE 实现单次核销。
* ``agent_seats``：席位 = 一个本机 Agent 在一个房间里的身份。
  唯一约束 ``(helper_id, agent_key, room_id)`` 让「重新加入」复用同一行。

本迁移做什么
------------
只建三张新表与它们的索引、外键、唯一约束；不改任何既有表，不回填数据。

在 SQLite 上的注意
------------------
``conftest.py`` 的测试库用 ``Base.metadata.create_all`` 直接按模型建表，
不经过本迁移。本迁移只在真实 PostgreSQL 上执行。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "j00c20261117"
down_revision: Union[str, None] = "i90c20261017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "helper_devices",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_user_id", sa.String(36), nullable=False),
        sa.Column("device_name", sa.String(64), nullable=False),
        sa.Column("platform", sa.String(16), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("token_salt", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], name="fk_helper_devices_owner"),
    )
    op.create_index("ix_helper_devices_owner_user_id", "helper_devices", ["owner_user_id"])

    op.create_table(
        "helper_codes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("owner_user_id", sa.String(36), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("code_salt", sa.String(32), nullable=False),
        sa.Column("helper_id", sa.String(36), nullable=True),
        sa.Column("room_id", sa.String(36), nullable=True),
        sa.Column("agent_key", sa.String(64), nullable=True),
        sa.Column("owner_xmtp_address", sa.String(42), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], name="fk_helper_codes_owner"),
        sa.ForeignKeyConstraint(["helper_id"], ["helper_devices.id"], name="fk_helper_codes_helper"),
        sa.ForeignKeyConstraint(["room_id"], ["rooms.id"], name="fk_helper_codes_room"),
    )
    op.create_index("ix_helper_codes_owner_user_id", "helper_codes", ["owner_user_id"])
    op.create_index("ix_helper_codes_expires_at", "helper_codes", ["expires_at"])

    op.create_table(
        "agent_seats",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("helper_id", sa.String(36), nullable=False),
        sa.Column("agent_user_id", sa.String(36), nullable=False),
        sa.Column("room_id", sa.String(36), nullable=False),
        sa.Column("agent_key", sa.String(64), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("xmtp_address", sa.String(42), nullable=False),
        sa.Column("group_status", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("group_added_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("helper_id", "agent_key", "room_id", name="uq_agent_seat_helper_agent_room"),
        sa.ForeignKeyConstraint(["helper_id"], ["helper_devices.id"], name="fk_agent_seats_helper"),
        sa.ForeignKeyConstraint(["agent_user_id"], ["users.id"], name="fk_agent_seats_agent_user"),
        sa.ForeignKeyConstraint(["room_id"], ["rooms.id"], name="fk_agent_seats_room"),
    )
    op.create_index("ix_agent_seats_room_id", "agent_seats", ["room_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_seats_room_id", table_name="agent_seats")
    op.drop_table("agent_seats")
    op.drop_index("ix_helper_codes_expires_at", table_name="helper_codes")
    op.drop_index("ix_helper_codes_owner_user_id", table_name="helper_codes")
    op.drop_table("helper_codes")
    op.drop_index("ix_helper_devices_owner_user_id", table_name="helper_devices")
    op.drop_table("helper_devices")
