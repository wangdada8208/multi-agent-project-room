"""add email auth fields on users and user_oauth_accounts table

Revision ID: k10c20261118
Revises: j00c20261117
Create Date: 2026-11-18

背景
----
为网站接入邮箱验证码注册、邮箱登录与 Google 一键登录：
1. 在 ``users`` 表新增可空列 ``email``、``normalized_email``、``email_verified_at``，
   并在 ``normalized_email`` 上建唯一索引 ``ux_users_normalized_email``
   （历史用户与 Agent 账号均为 NULL，PostgreSQL 唯一索引允许多个 NULL 互不冲突）。
2. 新增 ``user_oauth_accounts`` 表，用不可变的 ``(provider, provider_subject)`` 绑定
   外部身份（例如 Google ``sub``），不存储第三方 OAuth access/refresh token。

在 SQLite 上的注意
------------------
``conftest.py`` 的测试库用 ``Base.metadata.create_all`` 直接按模型建表，
本迁移用 ``batch_alter_table`` 兼容离线 DDL 与真实 PostgreSQL。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "k10c20261118"
down_revision: Union[str, None] = "j00c20261117"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column("email", sa.String(length=254), nullable=True))
        batch_op.add_column(sa.Column("normalized_email", sa.String(length=254), nullable=True))
        batch_op.add_column(sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.create_index("ux_users_normalized_email", ["normalized_email"], unique=True)

    op.create_table(
        "user_oauth_accounts",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("provider_subject", sa.String(length=255), nullable=False),
        sa.Column("provider_email", sa.String(length=254), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_user_oauth_accounts_user_id",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("provider", "provider_subject", name="uq_user_oauth_provider_subject"),
        sa.UniqueConstraint("user_id", "provider", name="uq_user_oauth_user_provider"),
    )
    op.create_index("ix_user_oauth_accounts_user_id", "user_oauth_accounts", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_user_oauth_accounts_user_id", table_name="user_oauth_accounts")
    op.drop_table("user_oauth_accounts")
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_index("ux_users_normalized_email")
        batch_op.drop_column("email_verified_at")
        batch_op.drop_column("normalized_email")
        batch_op.drop_column("email")
