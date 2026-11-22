"""Shared model package.

Importing submodules registers their tables on ``Base.metadata``. Module
packages that own their models elsewhere (e.g. ``app.activity``) are pulled
in here so ``Base.metadata.create_all`` / Alembic autogenerate see every
table after ``import app.models``.
"""

import app.activity.models  # noqa: F401
