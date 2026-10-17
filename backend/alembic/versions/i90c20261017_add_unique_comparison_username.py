"""add unique constraint on users.comparison_username (H3)

Revision ID: i90c20261017
Revises: h80c20261015
Create Date: 2026-10-17

背景
----
H3：注册判重以前只折叠大小写，`race_x_bot` 与 `race_x-bot` 被当成两个人，
两次注册都能成功。应用层的判重口径已在 0d8d5c9 修正（视为同一个人），
但「先查后插」仍有并发窗口：两个请求同时到达时都查到"没有"，于是都插入。
数据库层的唯一约束是关掉这个窗口的唯一可靠手段。

本迁移做什么
------------
1. 新增一列 `comparison_username`：存「比较键」= 大小写折叠 + 把 _ - . · ・
   统一成 -。它与应用层 `comparison_identity()` 的口径完全一致。
2. 回填已有账号的比较键。
3. 在 `comparison_username` 上建唯一索引。

为什么新开一列，而不是直接在 `normalized_username` 上加唯一索引
------------------------------------------------------------
`normalized_username` 存的是旧口径（不折叠标点）。如果直接给它加唯一约束，
数据库会允许 `race_x_bot` 和 `race_x-bot` 同时存在——约束形状和我们要的语义不符。
保留 `normalized_username` 原样不动，是刻意的：它是登录路径仍在使用的索引，
本次不改登录口径，避免把「现有账号被锁外」的风险带进来。

**不删任何账号。** 如果回填时发现重复，本迁移直接报错退出，交给人工处置。

在 SQLite 上的注意
------------------
`conftest.py` 的测试库用 SQLite，`Base.metadata.create_all` 会直接按模型建表，
不经过本迁移。本迁移只在真实 PostgreSQL 上执行。
"""
from typing import Sequence, Union
import unicodedata

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "i90c20261017"
down_revision: Union[str, None] = "h80c20261015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEX_NAME = "ux_users_comparison_username"
_PUNCTUATION = str.maketrans({"_": "-", ".": "-", "·": "-", "・": "-"})


def comparison_key(value: str) -> str:
    """与 backend/app/agent/identity.py 的 comparison_identity 保持一致。"""
    if not isinstance(value, str):
        return ""
    folded = unicodedata.normalize("NFKC", value.strip()).casefold()
    return folded.translate(_PUNCTUATION)


def upgrade() -> None:
    bind = op.get_bind()

    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("comparison_username", sa.String(length=64), nullable=True))

    user_table = sa.table(
        "users",
        sa.column("id", sa.String),
        sa.column("username", sa.String),
        sa.column("comparison_username", sa.String),
    )

    rows = bind.execute(sa.select(user_table.c.id, user_table.c.username)).fetchall()

    # 先算一遍，发现重复就在动索引之前停下——不删号、不合并、不猜。
    seen: dict[str, list[str]] = {}
    for row in rows:
        seen.setdefault(comparison_key(row[1]), []).append(row[1])
    conflicts = {k: v for k, v in seen.items() if len(v) > 1}
    if conflicts:
        sample = ", ".join(f"{k} ({len(v)} 个)" for k, v in list(conflicts.items())[:5])
        raise RuntimeError(
            "users 表里存在被判为同一个人的重复账号，已在建唯一索引之前停止。"
            f"冲突组数={len(conflicts)}，例如：{sample}。"
            "请由人类按执行手册第 4 节处置后重跑本迁移。本迁移不会自动删号。"
        )

    for row in rows:
        bind.execute(
            user_table.update()
            .where(user_table.c.id == row[0])
            .values(comparison_username=comparison_key(row[1]))
        )

    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.alter_column("comparison_username", nullable=False, server_default="")
        batch_op.create_index(INDEX_NAME, ["comparison_username"], unique=True)


def downgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_index(INDEX_NAME)
        batch_op.drop_column("comparison_username")
