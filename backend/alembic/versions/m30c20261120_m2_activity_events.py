"""m2: safe-metadata activity events + signed ledger checkpoint anchors

Revision ID: m30c20261120
Revises: l20c20261120
Create Date: 2026-11-20

背景
----
m2 迁移（WP4 统一活动流，docs/项目计划 m2 批次）：

* ``activity_events``：本机 helper / 云端 Agent 上报的**安全元数据**
  事件。硬红线：本表绝不设置 ``payload``/``content``/``params_hash``/
  ``digest`` 等可装正文或可猜测摘要的列——只有房间、操作者、类型、
  状态、主体 id、流序号与时间戳。``id`` 由上报方生成，是天然幂等键。
* ``activity_checkpoints``：worker 本地账本链头的 EIP-191 签名锚点。
  Hub 只保存 ``(stream_id, head_seq, head_hash, entry_count)`` 与签名，
  用来检测账本被改写、重排或相对锚点被截断；不接触任何账本正文。
  唯一约束 ``(room_id, stream_id, head_seq)`` 配合应用层单调性校验
  实现「同 seq 不同 hash 即冲突、完全重复即幂等」。

在 SQLite 上的注意
------------------
两张表都是新建表（``create_table`` + ``create_index``），无列修改；
``sa.DateTime(timezone=True)``、CHECK 约束与部分索引在 SQLite 与
PostgreSQL 上语义一致。``conftest.py`` 的测试库由模型直接
``create_all``，模型定义与本迁移保持同一形态。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "m30c20261120"
down_revision: Union[str, None] = "l20c20261120"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── activity_events: safe metadata only — NO payload/content/digest ──
    op.create_table(
        "activity_events",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("room_id", sa.String(length=36), nullable=False),
        sa.Column("actor_kind", sa.String(length=16), nullable=False),
        sa.Column("actor_id", sa.String(length=128), nullable=False),
        sa.Column("kind", sa.String(length=48), nullable=False),
        sa.Column("app", sa.String(length=32), nullable=True),
        sa.Column("status", sa.String(length=24), nullable=True),
        sa.Column("subject_id", sa.String(length=64), nullable=True),
        sa.Column("stream_seq", sa.Integer(), nullable=True),
        sa.Column("reported_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["room_id"], ["rooms.id"], name="fk_activity_events_room", ondelete="CASCADE"
        ),
        sa.CheckConstraint(
            "actor_kind IN ('human','agent','helper','system')",
            name="ck_activity_events_actor_kind",
        ),
    )
    op.create_index(
        "ix_activity_events_room_time",
        "activity_events",
        ["room_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "ix_activity_events_room_actor_time",
        "activity_events",
        ["room_id", "actor_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "ix_activity_events_room_kind_status",
        "activity_events",
        ["room_id", "kind", "status"],
    )

    # ── activity_checkpoints: signed ledger head anchors ──
    op.create_table(
        "activity_checkpoints",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("room_id", sa.String(length=36), nullable=False),
        sa.Column("stream_id", sa.String(length=64), nullable=False),
        sa.Column("signer_address", sa.String(length=42), nullable=False),
        sa.Column("head_seq", sa.Integer(), nullable=False),
        sa.Column("head_hash", sa.String(length=64), nullable=False),
        sa.Column("entry_count", sa.Integer(), nullable=False),
        sa.Column("signature", sa.String(length=132), nullable=False),
        sa.Column("reported_by", sa.String(length=64), nullable=True),
        sa.Column("checkpoint_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["room_id"], ["rooms.id"], name="fk_activity_checkpoints_room", ondelete="CASCADE"
        ),
        sa.CheckConstraint("head_seq >= 0", name="ck_activity_checkpoints_head_seq"),
        sa.CheckConstraint("entry_count >= 0", name="ck_activity_checkpoints_entry_count"),
        sa.UniqueConstraint(
            "room_id", "stream_id", "head_seq", name="uq_activity_checkpoints_stream_seq"
        ),
    )
    op.create_index(
        "ix_activity_checkpoints_stream_head",
        "activity_checkpoints",
        ["room_id", "stream_id", sa.text("head_seq DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_activity_checkpoints_stream_head", table_name="activity_checkpoints")
    op.drop_table("activity_checkpoints")

    op.drop_index("ix_activity_events_room_kind_status", table_name="activity_events")
    op.drop_index("ix_activity_events_room_actor_time", table_name="activity_events")
    op.drop_index("ix_activity_events_room_time", table_name="activity_events")
    op.drop_table("activity_events")
