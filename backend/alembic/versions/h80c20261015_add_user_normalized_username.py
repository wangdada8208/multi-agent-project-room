"""add normalized_username to users

Revision ID: h80c20261015
Revises: g70c20261012
Create Date: 2026-10-15 03:30:00.000000

"""
from typing import Sequence, Union
import unicodedata
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'h80c20261015'
down_revision: Union[str, None] = 'g70c20261012'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _normalize_unicode_casefold(value: str) -> str:
    if not isinstance(value, str):
        return ""
    return unicodedata.normalize("NFKC", value.strip()).casefold()


def upgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('normalized_username', sa.String(length=64), nullable=True))

    bind = op.get_bind()
    user_table = sa.table(
        'users',
        sa.column('id', sa.String),
        sa.column('username', sa.String),
        sa.column('normalized_username', sa.String),
    )
    rows = bind.execute(sa.select(user_table.c.id, user_table.c.username)).fetchall()
    for row in rows:
        uid, uname = row[0], row[1]
        norm = _normalize_unicode_casefold(uname)
        bind.execute(
            user_table.update().where(user_table.c.id == uid).values(normalized_username=norm)
        )

    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.alter_column('normalized_username', nullable=False, server_default='')
        batch_op.create_index('ix_users_normalized_username', ['normalized_username'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_index('ix_users_normalized_username')
        batch_op.drop_column('normalized_username')