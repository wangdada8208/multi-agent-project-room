# 2026-11-12 — `alembic check` schema-drift fix verification

## 0. Conclusion

**`alembic check` is now clean** on a database created by `alembic upgrade head`:
`No new upgrade operations detected.`, exit code `0`, reproduced on two independent
fresh databases. Single head remains `i90c20261017`. **No migration was added or
modified.** No production database was touched; all work was done on an isolated
PostgreSQL 17 instance on port **55433**.

The 8 pre-existing drift tables recorded in
`docs/verification/2026-10-19-第四轮修复验收报告.md` §9.7 and
`docs/verification/2026-10-19-生产迁移与发布密钥门禁修复.md` §5.3 were all
resolved **purely as ORM metadata alignment** — no DB schema change was required,
and no discrepancy had to be left behind as unfixable.

## 1. Environment and exact commands

Isolated instance (never 5432, never 55432, never 6379/56379):

```bash
/usr/lib/postgresql/17/bin/initdb -D /tmp/mapr-drift-pgdata -U postgres --auth=trust
/usr/lib/postgresql/17/bin/pg_ctl -D /tmp/mapr-drift-pgdata -o "-p 55433 -k /tmp" -l /tmp/mapr-drift-pg.log start
# initdb under locale C produced SQL_ASCII databases; schema comparison is
# encoding-independent (only column types/lengths, nullability, indexes and
# constraints are compared).
/usr/lib/postgresql/17/bin/psql -h 127.0.0.1 -p 55433 -U postgres -d postgres -c "CREATE DATABASE agent_room_check;"
/usr/lib/postgresql/17/bin/psql -h 127.0.0.1 -p 55433 -U postgres -d postgres -c "CREATE DATABASE agent_room_test;"
```

Every `alembic` / `pytest` command was run from the repo root with:

```bash
MAPR_DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:55433/agent_room_check \
PYTHONPATH=backend .venv/bin/python -m alembic <args>
```

`alembic heads` → `i90c20261017 (head)` (single head).
`SELECT version_num FROM alembic_version` on the migrated scratch DB → `i90c20261017`.
`git status --short -- backend/alembic/versions/` → empty (no new/edited migration).

Port check at the end of the run: only my own `55433` postgres was started by me;
`55432` (another teammate's PostgreSQL) and `56379` (a redis-server started by
someone else) were already present and were **not** used or modified by me.
No Redis was started; the tests needed none (see §7).

## 2. Baseline drift output (BEFORE the fix)

Fresh `agent_room_check`, `alembic upgrade head` (exit 0, all 20 revisions applied
through `i90c20261017`), then:

```bash
MAPR_DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:55433/agent_room_check \
PYTHONPATH=backend .venv/bin/python -m alembic check
```

Exit code **255**. Full captured output (26 lines; the final `ERROR` and `FAILED`
lines repeat the same operation list verbatim):

```text
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
INFO  [alembic.runtime.plugins] setting up autogenerate plugin alembic.autogenerate.schemas
INFO  [alembic.runtime.plugins] setting up autogenerate plugin alembic.autogenerate.tables
INFO  [alembic.runtime.plugins] setting up autogenerate plugin alembic.autogenerate.types
INFO  [alembic.runtime.plugins] setting up autogenerate plugin alembic.autogenerate.constraints
INFO  [alembic.runtime.plugins] setting up autogenerate plugin alembic.autogenerate.defaults
INFO  [alembic.runtime.plugins] setting up autogenerate plugin alembic.autogenerate.comments
INFO  [alembic.autogenerate.compare.constraints] Detected removed index 'ix_analytics_room_type' on 'analytics_events'
INFO  [alembic.autogenerate.compare.constraints] Detected removed index 'ix_analytics_user_time' on 'analytics_events'
INFO  [alembic.autogenerate.compare.tables] Detected removed table 'analytics_events'
INFO  [alembic.autogenerate.compare.constraints] Detected removed index 'ix_room_files_room_id' on 'room_files'
INFO  [alembic.autogenerate.compare.tables] Detected removed table 'room_files'
INFO  [alembic.autogenerate.compare.tables] Detected removed table 'room_permissions'
INFO  [alembic.autogenerate.compare.tables] Detected removed table 'room_templates'
INFO  [alembic.autogenerate.compare.constraints] Detected removed index 'ix_room_share_tokens_room_id' on 'room_share_tokens'
INFO  [alembic.autogenerate.compare.tables] Detected removed table 'room_share_tokens'
INFO  [alembic.autogenerate.compare.constraints] Detected removed index 'ix_knowledge_docs_room_updated' on 'knowledge_docs'
INFO  [alembic.autogenerate.compare.constraints] Detected added index 'ix_knowledge_docs_updated_at' on '('updated_at',)'
INFO  [alembic.autogenerate.compare.constraints] Detected removed index 'uq_message_client_key' on 'messages'
INFO  [alembic.autogenerate.compare.constraints] Detected added unique constraint 'uq_message_client_key' on '('room_id', 'sender_id', 'client_message_id')'
INFO  [alembic.autogenerate.compare.constraints] Detected removed index 'uq_message_room_seq' on 'messages'
INFO  [alembic.autogenerate.compare.constraints] Detected added unique constraint 'uq_message_room_seq' on '('room_id', 'room_seq')'
INFO  [alembic.autogenerate.compare.constraints] Detected removed index 'ix_room_invites_room_id' on 'room_invites'
ERROR [alembic.util.messaging] New upgrade operations detected: [('remove_index', Index('ix_analytics_room_type', Column('room_id', VARCHAR(length=36), table=<analytics_events>), Column('event_type', VARCHAR(length=64), table=<analytics_events>, nullable=False))), ('remove_index', Index('ix_analytics_user_time', Column('user_id', VARCHAR(length=36), table=<analytics_events>), Column('created_at', TIMESTAMP(timezone=True), table=<analytics_events>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b6ca510>, for_update=False)))), ('remove_table', Table('analytics_events', MetaData(), Column('id', VARCHAR(length=36), table=<analytics_events>, primary_key=True, nullable=False), Column('event_type', VARCHAR(length=64), table=<analytics_events>, nullable=False), Column('user_id', VARCHAR(length=36), table=<analytics_events>), Column('room_id', VARCHAR(length=36), table=<analytics_events>), Column('metadata_json', TEXT(), table=<analytics_events>), Column('created_at', TIMESTAMP(timezone=True), table=<analytics_events>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b6ca510>, for_update=False)), schema=None)), ('remove_index', Index('ix_room_files_room_id', Column('room_id', VARCHAR(length=36), table=<room_files>, nullable=False))), ('remove_table', Table('room_files', MetaData(), Column('id', VARCHAR(length=36), table=<room_files>, primary_key=True, nullable=False), Column('room_id', VARCHAR(length=36), ForeignKey('rooms.id'), table=<room_files>, nullable=False), Column('filename', VARCHAR(length=255), table=<room_files>, nullable=False), Column('stored_name', VARCHAR(length=255), table=<room_files>, nullable=False), Column('size', INTEGER(), table=<room_files>, nullable=False), Column('uploaded_by', VARCHAR(length=64), table=<room_files>, nullable=False), Column('uploaded_at', TIMESTAMP(timezone=True), table=<room_files>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b5791d0>, for_update=False)), schema=None)), ('remove_table', Table('room_permissions', MetaData(), Column('id', VARCHAR(length=36), table=<room_permissions>, primary_key=True, nullable=False), Column('room_id', VARCHAR(length=36), ForeignKey('rooms.id'), table=<room_permissions>, nullable=False), Column('user_id', VARCHAR(length=36), ForeignKey('users.id'), table=<room_permissions>, nullable=False), Column('role', VARCHAR(length=16), table=<room_permissions>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b579a90>, for_update=False)), Column('invited_by', VARCHAR(length=36), table=<room_permissions>), Column('created_at', TIMESTAMP(timezone=True), table=<room_permissions>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b5c5350>, for_update=False)), schema=None)), ('remove_table', Table('room_templates', MetaData(), Column('id', VARCHAR(length=36), table=<room_templates>, primary_key=True, nullable=False), Column('key', VARCHAR(length=64), table=<room_templates>, nullable=False), Column('name', VARCHAR(length=128), table=<room_templates>, nullable=False), Column('description', TEXT(), table=<room_templates>), Column('icon', VARCHAR(length=16), table=<room_templates>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b5c5cd0>, for_update=False)), Column('team_config_markdown', TEXT(), table=<room_templates>), Column('is_system', BOOLEAN(), table=<room_templates>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b5adc70>, for_update=False)), Column('created_at', TIMESTAMP(timezone=True), table=<room_templates>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b5158c0>, for_update=False)), schema=None)), ('remove_index', Index('ix_room_share_tokens_room_id', Column('room_id', VARCHAR(length=36), table=<room_share_tokens>, nullable=False))), ('remove_table', Table('room_share_tokens', MetaData(), Column('id', VARCHAR(length=36), table=<room_share_tokens>, primary_key=True, nullable=False), Column('room_id', VARCHAR(length=36), ForeignKey('rooms.id'), table=<room_share_tokens>, nullable=False), Column('token', VARCHAR(length=128), table=<room_share_tokens>, nullable=False), Column('created_by', VARCHAR(length=36), table=<room_share_tokens>, nullable=False), Column('expires_at', TIMESTAMP(timezone=True), table=<room_share_tokens>, nullable=False), Column('created_at', TIMESTAMP(timezone=True), table=<room_share_tokens>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b515ae0>, for_update=False)), schema=None)), ('remove_index', Index('ix_knowledge_docs_room_updated', Column('room_id', VARCHAR(length=36), table=<knowledge_docs>, nullable=False), Column('updated_at', TIMESTAMP(timezone=True), table=<knowledge_docs>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b4296d0>, for_update=False)))), ('add_index', Index('ix_knowledge_docs_updated_at', Column('updated_at', DateTime(timezone=True), table=<knowledge_docs>, nullable=False, onupdate=CallableColumnDefault(<function KnowledgeDoc.<lambda> at 0x7f756b641b20>), default=CallableColumnDefault(<function KnowledgeDoc.<lambda> at 0x7f756b641a80>)))), ('remove_index', Index('uq_message_client_key', Column('room_id', VARCHAR(length=36), table=<messages>, nullable=False), Column('sender_id', VARCHAR(length=36), table=<messages>, nullable=False), Column('client_message_id', VARCHAR(length=128), table=<messages>), unique=True)), ('add_constraint', UniqueConstraint(Column('room_id', NullType(), table=<messages>), Column('sender_id', NullType(), table=<messages>), Column('client_message_id', NullType(), table=<messages>))), ('remove_index', Index('uq_message_room_seq', Column('room_id', VARCHAR(length=36), table=<messages>, nullable=False), Column('room_seq', BIGINT(), table=<messages>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b5a9790>, for_update=False)), unique=True)), ('add_constraint', UniqueConstraint(Column('room_id', NullType(), table=<messages>), Column('room_seq', NullType(), table=<messages>))), ('remove_index', Index('ix_room_invites_room_id', Column('room_id', VARCHAR(length=36), table=<room_invites>, nullable=False)))]
FAILED: New upgrade operations detected: [('remove_index', Index('ix_analytics_room_type', Column('room_id', VARCHAR(length=36), table=<analytics_events>), Column('event_type', VARCHAR(length=64), table=<analytics_events>, nullable=False))), ('remove_index', Index('ix_analytics_user_time', Column('user_id', VARCHAR(length=36), table=<analytics_events>), Column('created_at', TIMESTAMP(timezone=True), table=<analytics_events>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b6ca510>, for_update=False)))), ('remove_table', Table('analytics_events', MetaData(), Column('id', VARCHAR(length=36), table=<analytics_events>, primary_key=True, nullable=False), Column('event_type', VARCHAR(length=64), table=<analytics_events>, nullable=False), Column('user_id', VARCHAR(length=36), table=<analytics_events>), Column('room_id', VARCHAR(length=36), table=<analytics_events>), Column('metadata_json', TEXT(), table=<analytics_events>), Column('created_at', TIMESTAMP(timezone=True), table=<analytics_events>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b6ca510>, for_update=False)), schema=None)), ('remove_index', Index('ix_room_files_room_id', Column('room_id', VARCHAR(length=36), table=<room_files>, nullable=False))), ('remove_table', Table('room_files', MetaData(), Column('id', VARCHAR(length=36), table=<room_files>, primary_key=True, nullable=False), Column('room_id', VARCHAR(length=36), ForeignKey('rooms.id'), table=<room_files>, nullable=False), Column('filename', VARCHAR(length=255), table=<room_files>, nullable=False), Column('stored_name', VARCHAR(length=255), table=<room_files>, nullable=False), Column('size', INTEGER(), table=<room_files>, nullable=False), Column('uploaded_by', VARCHAR(length=64), table=<room_files>, nullable=False), Column('uploaded_at', TIMESTAMP(timezone=True), table=<room_files>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b5791d0>, for_update=False)), schema=None)), ('remove_table', Table('room_permissions', MetaData(), Column('id', VARCHAR(length=36), table=<room_permissions>, primary_key=True, nullable=False), Column('room_id', VARCHAR(length=36), ForeignKey('rooms.id'), table=<room_permissions>, nullable=False), Column('user_id', VARCHAR(length=36), ForeignKey('users.id'), table=<room_permissions>, nullable=False), Column('role', VARCHAR(length=16), table=<room_permissions>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b579a90>, for_update=False)), Column('invited_by', VARCHAR(length=36), table=<room_permissions>), Column('created_at', TIMESTAMP(timezone=True), table=<room_permissions>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b5c5350>, for_update=False)), schema=None)), ('remove_table', Table('room_templates', MetaData(), Column('id', VARCHAR(length=36), table=<room_templates>, primary_key=True, nullable=False), Column('key', VARCHAR(length=64), table=<room_templates>, nullable=False), Column('name', VARCHAR(length=128), table=<room_templates>, nullable=False), Column('description', TEXT(), table=<room_templates>), Column('icon', VARCHAR(length=16), table=<room_templates>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b5c5cd0>, for_update=False)), Column('team_config_markdown', TEXT(), table=<room_templates>), Column('is_system', BOOLEAN(), table=<room_templates>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b5adc70>, for_update=False)), Column('created_at', TIMESTAMP(timezone=True), table=<room_templates>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b5158c0>, for_update=False)), schema=None)), ('remove_index', Index('ix_room_share_tokens_room_id', Column('room_id', VARCHAR(length=36), table=<room_share_tokens>, nullable=False))), ('remove_table', Table('room_share_tokens', MetaData(), Column('id', VARCHAR(length=36), table=<room_share_tokens>, primary_key=True, nullable=False), Column('room_id', VARCHAR(length=36), ForeignKey('rooms.id'), table=<room_share_tokens>, nullable=False), Column('token', VARCHAR(length=128), table=<room_share_tokens>, nullable=False), Column('created_by', VARCHAR(length=36), table=<room_share_tokens>, nullable=False), Column('expires_at', TIMESTAMP(timezone=True), table=<room_share_tokens>, nullable=False), Column('created_at', TIMESTAMP(timezone=True), table=<room_share_tokens>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b515ae0>, for_update=False)), schema=None)), ('remove_index', Index('ix_knowledge_docs_room_updated', Column('room_id', VARCHAR(length=36), table=<knowledge_docs>, nullable=False), Column('updated_at', TIMESTAMP(timezone=True), table=<knowledge_docs>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b4296d0>, for_update=False)))), ('add_index', Index('ix_knowledge_docs_updated_at', Column('updated_at', DateTime(timezone=True), table=<knowledge_docs>, nullable=False, onupdate=CallableColumnDefault(<function KnowledgeDoc.<lambda> at 0x7f756b641b20>), default=CallableColumnDefault(<function KnowledgeDoc.<lambda> at 0x7f756b641a80>)))), ('remove_index', Index('uq_message_client_key', Column('room_id', VARCHAR(length=36), table=<messages>, nullable=False), Column('sender_id', VARCHAR(length=36), table=<messages>, nullable=False), Column('client_message_id', VARCHAR(length=128), table=<messages>), unique=True)), ('add_constraint', UniqueConstraint(Column('room_id', NullType(), table=<messages>), Column('sender_id', NullType(), table=<messages>), Column('client_message_id', NullType(), table=<messages>))), ('remove_index', Index('uq_message_room_seq', Column('room_id', VARCHAR(length=36), table=<messages>, nullable=False), Column('room_seq', BIGINT(), table=<messages>, nullable=False, server_default=DefaultClause(<sqlalchemy.sql.elements.TextClause object at 0x7f756b5a9790>, for_update=False)), unique=True)), ('add_constraint', UniqueConstraint(Column('room_id', NullType(), table=<messages>), Column('room_seq', NullType(), table=<messages>))), ('remove_index', Index('ix_room_invites_room_id', Column('room_id', VARCHAR(length=36), table=<room_invites>, nullable=False)))]
```

The final `ERROR` and `FAILED` lines repeat the same operation list verbatim:
`remove_index ix_analytics_room_type`, `remove_index ix_analytics_user_time`,
`remove_table analytics_events`, `remove_index ix_room_files_room_id`,
`remove_table room_files`, `remove_table room_permissions`,
`remove_table room_templates`, `remove_index ix_room_share_tokens_room_id`,
`remove_table room_share_tokens`, `remove_index ix_knowledge_docs_room_updated`,
`add_index ix_knowledge_docs_updated_at`, `remove_index uq_message_client_key`,
`add_constraint uq_message_client_key`, `remove_index uq_message_room_seq`,
`add_constraint uq_message_room_seq`, `remove_index ix_room_invites_room_id`.

### Root-cause mapping (verified against the migrated DB, not inferred)

| Table | Baseline symptom | What the migration chain actually creates | Fix |
|---|---|---|---|
| `analytics_events` | removed table + 2 removed indexes | `d40c20261010`: table + `ix_analytics_room_type(room_id,event_type)`, `ix_analytics_user_time(user_id,created_at)` | register model in metadata (`env.py`) |
| `room_files` | removed table + removed index | `d40c20261010`: table + `ix_room_files_room_id` + **named** UNIQUE constraint `uq_room_files_stored_name` | register + named `UniqueConstraint` |
| `room_permissions` | removed table | `d40c20261010`: table + named `uq_room_user` | register only (model already correct) |
| `room_templates` | removed table | `d40c20261010`: table + named `uq_room_templates_key` | register + named `UniqueConstraint` |
| `room_share_tokens` | removed table + removed index | `d40c20261010`: table + named `uq_room_share_tokens_token` + `ix_room_share_tokens_room_id` | register + named `UniqueConstraint` + index |
| `knowledge_docs` | wrong index name/columns | `7c2d4f9a1b20`: composite `ix_knowledge_docs_room_updated(room_id,updated_at)` | declare composite `Index`, drop standalone `updated_at` index |
| `messages` | index↔constraint type mismatch | `e50c20261011`: `op.create_index(..., unique=True)` → **UNIQUE INDEXes** `uq_message_room_seq`, `uq_message_client_key` | declare `Index(unique=True)` instead of `UniqueConstraint` |
| `room_invites` | removed index | `f9a1c2d3e4b5`: `op.create_index("ix_room_invites_room_id", ...)` | declare `Index` in `__table_args__` |

DB introspection used to distinguish the two kinds of uniqueness
(`pg_constraint.contype='u'` vs `pg_indexes` with no matching constraint):

```text
UNIQUE CONSTRAINTS: uq_room_files_stored_name, uq_room_user,
                    uq_room_share_tokens_token, uq_room_templates_key
UNIQUE INDEXES    : uq_message_client_key, uq_message_room_seq
```

## 3. All changed files

### 3.1 Edited by `schema-drift` (my write scope: `backend/app/models/*.py`)

**`backend/app/models/room_invite.py`**
- `:6` — added `Index` to the `sqlalchemy` import.
- `:14-16` — added `__table_args__ = (Index("ix_room_invites_room_id", "room_id"),)`.

**`backend/app/models/room_share.py`**
- `:6` — added `Index, UniqueConstraint` to the import.
- `:14-21` — added `__table_args__` with
  `UniqueConstraint("token", name="uq_room_share_tokens_token")` and
  `Index("ix_room_share_tokens_room_id", "room_id")`.
- `:25` — removed the bare `unique=True` from `token` (replaced by the named
  constraint above); column, nullability and Python attribute name unchanged.

**`backend/app/models/room_template.py`**
- `:6` — added `UniqueConstraint` to the import.
- `:14-16` — added `__table_args__ = (UniqueConstraint("key", name="uq_room_templates_key"),)`.
- `:19` — removed the bare `unique=True` from `key`; column and attribute name unchanged.

Exact diff of these three files:

```diff
--- a/backend/app/models/room_invite.py
+++ b/backend/app/models/room_invite.py
@@ -3,7 +3,7 @@
-from sqlalchemy import String, DateTime, ForeignKey, JSON
+from sqlalchemy import String, DateTime, ForeignKey, JSON, Index
@@ -11,6 +11,10 @@
 class RoomInvite(Base):
     __tablename__ = "room_invites"
+    # f9a1c2d3e4b5 creates this index explicitly; declare it in metadata so
+    # autogenerate does not propose dropping it.
+    __table_args__ = (Index("ix_room_invites_room_id", "room_id"),)

--- a/backend/app/models/room_share.py
+++ b/backend/app/models/room_share.py
@@ -3,7 +3,7 @@
-from sqlalchemy import String, DateTime, ForeignKey
+from sqlalchemy import String, DateTime, ForeignKey, Index, UniqueConstraint
@@ -11,9 +11,18 @@
 class RoomShareToken(Base):
     __tablename__ = "room_share_tokens"
+    # Migration d40c20261010 creates a *named* UNIQUE constraint on token and an
+    # explicit index on room_id. A bare `unique=True` on the column would emit an
+    # unnamed constraint and omit the room_id index, which `alembic check` sees
+    # as drift. These names are the DB's names; only ORM metadata changes here.
+    __table_args__ = (
+        UniqueConstraint("token", name="uq_room_share_tokens_token"),
+        Index("ix_room_share_tokens_room_id", "room_id"),
+    )
@@ -16,7 +25,7 @@
-    token: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
+    token: Mapped[str] = mapped_column(String(128), nullable=False)

--- a/backend/app/models/room_template.py
+++ b/backend/app/models/room_template.py
@@ -3,7 +3,7 @@
-from sqlalchemy import String, Boolean, DateTime, Text
+from sqlalchemy import String, Boolean, DateTime, Text, UniqueConstraint
@@ -11,8 +11,12 @@
 class RoomTemplate(Base):
     __tablename__ = "room_templates"
+    # d40c20261010 names this constraint explicitly. Keep the same name so the
+    # ORM metadata matches the migrated DB (a bare unique=True would not).
+    __table_args__ = (UniqueConstraint("key", name="uq_room_templates_key"),)
@@ -15,7 +19,7 @@
-    key: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
+    key: Mapped[str] = mapped_column(String(64), nullable=False)
```

### 3.2 Edited by `lead` (outside my write scope; listed for completeness — I did not edit these)

- **`backend/alembic/env.py:28-32`** — added `import app.files.models`,
  `app.models.analytics`, `app.models.room_permission`, `app.models.room_share`,
  `app.models.room_template` so the five legacy tables are present in
  `target_metadata` (removes the 5 `remove_table` drifts).
- **`backend/app/chat/models.py:16-17`** — `Message.__table_args__` now declares
  `Index("uq_message_room_seq", "room_id", "room_seq", unique=True)` and
  `Index("uq_message_client_key", "room_id", "sender_id", "client_message_id",
  unique=True)` instead of two `UniqueConstraint`s.
- **`backend/app/knowledge/models.py:21`** — `KnowledgeDoc.__table_args__` now
  declares `Index("ix_knowledge_docs_room_updated", "room_id", "updated_at")`;
  the standalone `index=True` on `updated_at` was dropped.
- **`backend/app/files/models.py:17`** — `RoomFile.__table_args__` now declares
  `UniqueConstraint("stored_name", name="uq_room_files_stored_name")`; the bare
  `unique=True` on `stored_name` was dropped.

### 3.3 Files deliberately NOT changed

- `backend/alembic/versions/*` — no new migration, no edits (`git status` empty).
- `backend/tests/*` — untouched.
- `backend/app/models/room.py` — restored to its original content
  (`git diff -- backend/app/models/room.py` is empty). An early experimental
  import hook and a new `backend/app/models/schema_alignment.py` monkey-patch
  module were **deleted** at lead's direction; the clean fix above supersedes
  them. No new module remains in the tree.
- No edits outside `backend/app/models/` and this report were made by me.
- No commits and no pushes were made.

## 4. Final `alembic check` output (clean)

Two independent fresh-database cycles were run; both produced the same result.
Each cycle: `DROP DATABASE agent_room_check` → `CREATE DATABASE agent_room_check`
→ `alembic upgrade head` (exit 0) → `alembic check`.

```bash
MAPR_DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:55433/agent_room_check \
PYTHONPATH=backend .venv/bin/python -m alembic check
```

Exit code **0**. Full output:

```text
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
INFO  [alembic.runtime.plugins] setting up autogenerate plugin alembic.autogenerate.schemas
INFO  [alembic.runtime.plugins] setting up autogenerate plugin alembic.autogenerate.tables
INFO  [alembic.runtime.plugins] setting up autogenerate plugin alembic.autogenerate.types
INFO  [alembic.runtime.plugins] setting up autogenerate plugin alembic.autogenerate.constraints
INFO  [alembic.runtime.plugins] setting up autogenerate plugin alembic.autogenerate.defaults
INFO  [alembic.runtime.plugins] setting up autogenerate plugin alembic.autogenerate.comments
No new upgrade operations detected.
```

`alembic heads` after the fix: `i90c20261017 (head)` (single head unchanged).
Lead independently reproduced the same clean result on a separate fresh database
`agent_room_lead_check` on the same 55433 instance.

## 5. `users` table — zero drift preserved

Scoped comparison of the real migrated DB (`agent_room_check`, revision
`i90c20261017`) against `Base.metadata.tables["users"]`, using
`sqlalchemy.inspect` for columns / nullability / indexes / unique constraints:

```text
DB column count   : 14
model column count: 14
DB columns        : ['avatar_url', 'comparison_username', 'created_at', 'display_name',
                    'id', 'is_active', 'is_online', 'last_seen_at',
                    'normalized_username', 'owner_bound_at', 'owner_user_id',
                    'password_hash', 'user_type', 'username']
only in DB        : []
only in model     : []
nullability mismatches: []
comparison_username in DB: True
DB unique indexes/constraints:
  ix_users_normalized_username (normalized_username, non-unique)
  ix_users_owner_user_id       (owner_user_id, non-unique)
  users_username_key           (username, unique)
  ux_users_comparison_username (comparison_username, unique)
ux_users_comparison_username present: True
PK: ['id']
total metadata tables: 19
```

This matches the §9.7 baseline (`DB column count: 14 | model column count: 14`,
`nullability mismatches: none`, `unique indexes: ['users_pkey',
'users_username_key', 'ux_users_comparison_username']`). No `users` model file was
edited.

## 6. Runtime-behavior preservation

- No column was renamed; no Python attribute name used by code changed.
- No enforcing constraint was dropped: the two `messages` `UniqueConstraint`s
  became unique `Index`es (identical UNIQUE enforcement, matching what
  `e50c20261011` actually built), and the three bare `unique=True` columns
  became explicitly named `UniqueConstraint`s on the same columns.
- No DDL was issued by the fix. Only ORM metadata declarations changed. The
  production database (already at `i90c20261017`) is schema-compatible with main
  and was never connected to.
- `Base.metadata.create_all()` (dev/SQLite test path) now emits the same index /
  constraint names as the migrated PostgreSQL schema.

## 7. Test results

Exact lead-required command (two test files), on my isolated PG:

```bash
MAPR_TESTING=1 \
MAPR_TEST_DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:55433/agent_room_test \
PYTHONPATH=backend .venv/bin/python -m pytest \
  backend/tests/test_migration_after_upgrade_linux.py \
  backend/tests/test_xmtp_room_storage.py -q
```

Result: **14 passed, 0 failed, 0 skipped in 12.25s** (exit 0).

The originally assigned command additionally included
`backend/tests/test_register_punctuation_identity.py`:

```bash
MAPR_TESTING=1 \
MAPR_TEST_DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:55433/agent_room_test \
PYTHONPATH=backend .venv/bin/python -m pytest \
  backend/tests/test_migration_after_upgrade_linux.py \
  backend/tests/test_xmtp_room_storage.py \
  backend/tests/test_register_punctuation_identity.py -q
```

Result: **26 passed, 0 failed, 0 skipped, 1 warning in 15.35s** (exit 0).
The single warning is the pre-existing `PytestCollectionWarning: cannot collect
'test_session' because it is not a function` from SQLAlchemy's
`async_sessionmaker.__call__`; unrelated to this change.

The migration test creates one-off `*_test` databases on the 55433 instance;
after both runs only `agent_room_test` remained (cleaned up correctly).

**Redis:** no Redis was needed and none was started by me. With `MAPR_TESTING=1`
and no `MAPR_REDIS_URL`, `conftest`'s `_flush_redis_state()` resolves the default
`redis://localhost:6379/15`; there is no listener on 6379, so the connection
fails and the limiter circuit-breaker short-circuits. Port 6379 was not used;
the pre-existing redis on 56379 belongs to another teammate and was untouched.

## 8. Residual discrepancies deliberately left (with reasons)

**None of the eight drift items required a DB schema change, and none was left
unfixed.** `alembic check` reports zero operations. The following are known
metadata differences that `alembic check` deliberately does not compare; they
are documented rather than force-changed, because changing them would alter
`create_all()` DDL (and thus runtime insert behavior) without affecting the
migrated PostgreSQL schema or the check result:

1. **Server defaults.** Migrations set DB-side defaults (`now()`,
   `'human'::varchar`, `'text'::varchar`, `'member'::varchar`, `true`, `'0'`,
   `'🏠'`); the ORM models use Python-side `default=`/`onupdate=` with no
   `server_default`. `backend/alembic/env.py` calls `context.configure(...)`
   without `compare_server_default=True`, so Alembic's default (`False`) applies
   and server defaults are not compared. Proof: the `users` table has this exact
   difference yet shows zero drift (§5). Adding `server_default` to ~20 columns
   would change SQLite `create_all()` DDL and expand the diff well beyond the
   drift fix while leaving production untouched — deliberately not done.

2. **Foreign-key constraint names.** The DB uses PostgreSQL-generated names
   (`room_files_room_id_fkey`, `room_invites_room_id_fkey`, …) or explicitly
   named FKs from `b4e8c7a92f10` / `c5f9d8e10a21`; ORM `ForeignKey(...)`
   declarations are unnamed. Alembic matches FKs by columns and referred table,
   not by name, so no drift appears. Left as-is; adding explicit names would
   change `create_all()` DDL only.

3. **Unnamed model-side unique constraint on `users.username`.** The DB has
   `users_username_key`; `user.py:42` still uses bare `unique=True`. Alembic
   skips unnamed unique constraints, so no drift appears (confirmed by the
   clean check and by §5). Left unchanged to avoid touching the H3-fixed `users`
   model.

4. **Scratch DB encoding.** `initdb` under locale `C` produced `SQL_ASCII`
   databases, whereas production is typically UTF-8. This is an artifact of the
   isolated test instance only; schema comparison (types, lengths, nullability,
   indexes, constraints) is encoding-independent and the clean result is
   unaffected.

## 9. Change inventory (final `git status` scope)

```text
 M backend/alembic/env.py
 M backend/app/chat/models.py
 M backend/app/files/models.py
 M backend/app/knowledge/models.py
 M backend/app/models/room_invite.py
 M backend/app/models/room_share.py
 M backend/app/models/room_template.py
?? docs/verification/2026-11-12-schema-drift-fix.md   (this report)
```

`backend/alembic/versions/` — clean (no new migration).
`backend/tests/` — clean (no edits).
No commits, no pushes.
