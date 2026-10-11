"""Independent SSE lease metadata, shared by all PostgreSQL Hubs.

Production execution requires separate approval and stopped SSE writers.
"""
from alembic import op
from app.a2a.sse_global_quota import LEASE_METADATA

revision = 'f60c20261011'
down_revision = 'e50c20261011'
branch_labels = None
depends_on = None


def upgrade():
    LEASE_METADATA.create_all(op.get_bind(), checkfirst=not op.get_context().as_sql)


def downgrade():
    LEASE_METADATA.drop_all(op.get_bind(), checkfirst=not op.get_context().as_sql)
