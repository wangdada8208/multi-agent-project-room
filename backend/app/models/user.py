from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import String, Boolean, DateTime, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, validates
from app.core.database import Base
from app.agent.identity import comparison_identity, normalize_unicode_casefold

# 数据库层唯一约束的名字。迁移 i90c20261017 建的就是这个名字，
# 模型侧必须与此一致，否则 SQLite 的 create_all()（默认测试路径）
# 与真实 PostgreSQL 迁移建出来的表形状会不一致。
COMPARISON_USERNAME_INDEX = "ux_users_comparison_username"


def _default_comparison_username(context) -> str:
    """从同一行正在插入的 ``username`` 推导比较键。

    常量默认值（``default=""``）有一个尖锐的失效模式：任何绕过
    ``@validates("username")`` 的写入路径（Core 的 ``users.insert()``、
    ``bulk_insert_mappings`` 等）都会把每一行写成 ``""``，于是第二行就撞上
    唯一索引——正是本 P0 的翻版。改成按行推导后，即使没走验证器，
    每一行也会拿到**自己的**比较键。

    取不到参数时退回 ``""``：让数据库的唯一约束以失败告终，而不是写进一个
    错误的身份键。
    """
    try:
        parameters = context.get_current_parameters() or {}
    except Exception:  # 不是 Python 侧默认值上下文
        parameters = {}
    username = parameters.get("username")
    return comparison_identity(username) if isinstance(username, str) else ""


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    normalized_username: Mapped[str] = mapped_column(
        String(64), nullable=False, index=True, default=""
    )
    # 判重比较键（非登录键，也绝不回写 username）：由 comparison_identity() 算出，
    # 口径 = 大小写折叠 + 把 _ - . · ・ 折成同一个分隔符。
    # 唯一约束由数据库强制，用来关掉「先查后插」的并发窗口（审计 H3）。
    #
    # 维护方式两条，互为兜底：
    # 1. @validates("username")：ORM 属性赋值（含构造函数）时同步；
    # 2. _default_comparison_username：ORM 以外的插入（Core/bulk）按本行
    #    username 推导，绝不落入共享的 ""。
    # `User()` 不传 username 不会造出空键行：username 是 NOT NULL 且无默认值，
    # INSERT 会以 NotNullViolation 失败。只有绕过本模型的手写 SQL 才可能拿到
    # 迁移里的 server_default=""，而那种写法在第二行就会被唯一索引拒绝——
    # 失败在明处，不会静默造出重复身份。
    comparison_username: Mapped[str] = mapped_column(
        String(64), nullable=False, default=_default_comparison_username
    )
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    user_type: Mapped[str] = mapped_column(
        String(16), nullable=False, default="human"
    )  # "human" | "agent"
    owner_user_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=True, index=True
    )
    owner_bound_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    avatar_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    is_online: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    password_hash: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    __table_args__ = (
        Index(COMPARISON_USERNAME_INDEX, "comparison_username", unique=True),
    )

    @validates("username")
    def _sync_normalized_username(self, key: str, value: str) -> str:
        if value:
            self.normalized_username = normalize_unicode_casefold(value)
            # 判重键与登录键必须分开维护：登录仍然用 normalized_username 的旧口径，
            # 判重用 comparison_identity() 的口径。两者都从同一个 username 派生，
            # 但任何一方都不得改写 username 本身。
            self.comparison_username = comparison_identity(value)
        return value

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "username": self.username,
            "display_name": self.display_name,
            "user_type": self.user_type,
            "avatar_url": self.avatar_url,
            "is_online": self.is_online,
            "is_active": self.is_active,
            "last_seen_at": self.last_seen_at.isoformat() if self.last_seen_at else None,
            "created_at": self.created_at.isoformat(),
        }
