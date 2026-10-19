"""e50 backfill and isolated synthetic backup/shadow recovery; never production."""
import importlib.util
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
import uuid

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.pool import NullPool
from conftest import engine as test_engine
from app.models.user import User
from app.models.room import Room
from app.chat.models import Message

MIGRATION = Path(__file__).resolve().parents[1] / 'alembic/versions/e50c20261011_room_sync.py'


def migration():
    spec=importlib.util.spec_from_file_location('room_sync_migration',MIGRATION)
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def old_schema(connection):
    meta=sa.MetaData()
    User.__table__.to_metadata(meta)
    for table,exclude in [(Room.__table__,{'message_seq'}),(Message.__table__,{'room_seq','client_message_id'})]:
        sa.Table(table.name,meta,*[column._copy() for column in table.columns if column.name not in exclude])
    meta.create_all(connection)
    users=meta.tables['users']; rooms=meta.tables['rooms']; messages=meta.tables['messages']
    stamp=datetime(2026,10,10,tzinfo=timezone.utc)
    connection.execute(users.insert(),dict(id='owner',username='owner',display_name='owner',user_type='human'))
    connection.execute(rooms.insert(),[dict(id='r1',name='one',transport='hub'),dict(id='r2',name='two',transport='hub')])
    # Same timestamp ties must be stable, independently per room; random UUID
    # order is used ONLY for historical committed backfill, never live discovery.
    connection.execute(messages.insert(),[dict(id=mid,room_id=rid,sender_id='owner',content=mid,created_at=stamp)
        for mid,rid in [('z','r1'),('b','r2'),('a','r1'),('c','r1')]])
    return meta


def upgrade(connection):
    with Operations.context(MigrationContext.configure(connection)):
        migration().upgrade()


def verify(connection):
    assert connection.execute(sa.text('SELECT id, room_seq FROM messages WHERE room_id=\'r1\' ORDER BY room_seq')).all()==[('a',1),('c',2),('z',3)]
    assert connection.execute(sa.text('SELECT message_seq FROM rooms WHERE id=\'r1\'')).scalar_one()==3
    assert connection.execute(sa.text('SELECT message_seq FROM rooms WHERE id=\'r2\'')).scalar_one()==1
    assert connection.execute(sa.text('SELECT COUNT(*) FROM messages')).scalar_one()==4


def test_sqlite_backfill_stable_unique_idempotent_and_backup_shadow(tmp_path):
    original=tmp_path/'original.db'; backup=tmp_path/'pre_e50.db'; shadow=tmp_path/'rollback_shadow.db'
    engine=sa.create_engine('sqlite:///'+str(original))
    with engine.begin() as connection: old_schema(connection)
    with sqlite3.connect(original) as source, sqlite3.connect(backup) as destination: source.backup(destination)
    with engine.begin() as connection:
        upgrade(connection); verify(connection); upgrade(connection); verify(connection)
        connection.execute(sa.text("INSERT INTO messages(id,room_id,sender_id,sender_type,content,msg_type,room_seq,created_at) VALUES('after','r1','owner','human','after','text',4,CURRENT_TIMESTAMP)"))
        connection.execute(sa.text("UPDATE rooms SET message_seq=4 WHERE id='r1'"))
    # Restore PRE-migration backup into a NEW shadow, never overwrite the source.
    with sqlite3.connect(backup) as source, sqlite3.connect(shadow) as destination: source.backup(destination)
    with sqlite3.connect(shadow) as recovered, sqlite3.connect(original) as source:
        columns=[r[1] for r in recovered.execute('PRAGMA table_info(messages)')]
        assert 'room_seq' not in columns
        recovered.execute('DELETE FROM messages')
        rows=source.execute('SELECT '+','.join(columns)+' FROM messages').fetchall()
        recovered.executemany('INSERT INTO messages('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',rows)
        recovered.commit()
        assert recovered.execute('SELECT id,content FROM messages ORDER BY id').fetchall()==source.execute('SELECT id,content FROM messages ORDER BY id').fetchall()
        assert recovered.execute('SELECT COUNT(*) FROM messages').fetchone()[0]==5
    engine.dispose()


@pytest.mark.asyncio
async def test_sqlite_migrated_counter_next_write_no_conflict(tmp_path):
    path=tmp_path/'next.db'; sync=sa.create_engine('sqlite:///'+str(path))
    with sync.begin() as c: old_schema(c); upgrade(c)
    sync.dispose()
    engine=create_async_engine('sqlite+aiosqlite:///'+str(path),poolclass=NullPool)
    try:
        async with async_sessionmaker(engine,expire_on_commit=False)() as db:
            one=Message(room_id='r1',sender_id='owner',content='next')
            two=Message(room_id='r2',sender_id='owner',content='other')
            db.add_all([one,two]); await db.commit()
            assert one.room_seq==4 and two.room_seq==2
    finally: await engine.dispose()


def test_destructive_downgrade_is_explicitly_blocked():
    with pytest.raises(RuntimeError,match='No destructive downgrade'):
        migration().downgrade()


@pytest.mark.asyncio
@pytest.mark.skipif(test_engine.dialect.name!='postgresql',reason='isolated PG17 migration gate')
async def test_pg_backfill_and_next_orm_write_no_collision():
    schema='e50_'+uuid.uuid4().hex
    # Dedicated schema in the opt-in *_test PG database; nothing outside it.
    try:
        async with test_engine.begin() as connection:
            await connection.execute(sa.text('CREATE SCHEMA '+schema))
            await connection.execute(sa.text('SET LOCAL search_path TO '+schema))
            await connection.run_sync(old_schema)
            await connection.run_sync(upgrade)
            await connection.run_sync(verify)
            await connection.run_sync(upgrade)
            async with async_sessionmaker(bind=connection,expire_on_commit=False,join_transaction_mode="create_savepoint")() as db:
                row=Message(room_id='r1',sender_id='owner',content='next')
                db.add(row); await db.flush(); assert row.room_seq==4
                await db.commit()
            # Session bound to outer transaction; flush write survives rollback?
            # Read through the same outer connection after session close.
            assert (await connection.execute(sa.text("SELECT message_seq FROM rooms WHERE id='r1'"))).scalar_one()==4
    finally:
        async with test_engine.begin() as c:
            await c.execute(sa.text('DROP SCHEMA IF EXISTS '+schema+' CASCADE'))

@pytest.mark.asyncio
async def test_pg17_synthetic_pre_migration_backup_restored_to_separate_shadow(tmp_path):
    import os
    import asyncio
    import subprocess
    import asyncpg
    root=os.environ.get('MAPR_ISOLATED_PG_ROOT','')
    port=int(os.environ.get('MAPR_ISOLATED_PG_PORT','55480'))
    if (test_engine.dialect.name!='postgresql' or not root.startswith('/tmp/')
            or test_engine.url.host!='127.0.0.1' or test_engine.url.port!=port):
        pytest.skip('requires explicitly owned /tmp PG17 cluster on the explicitly owned loopback port')
    binary=Path(root)/'usr/lib/postgresql/17/bin'
    assert (binary/'pg_dump').is_file() and (binary/'pg_restore').is_file()
    schema='recovery_'+uuid.uuid4().hex
    shadow='stage5a_shadow_'+uuid.uuid4().hex+'_test'
    archive=tmp_path/'pre_e50.dump'
    url=test_engine.url.set(drivername='postgresql').render_as_string(hide_password=False)
    env=os.environ.copy(); env['LD_LIBRARY_PATH']=str(Path(root)/'usr/lib/x86_64-linux-gnu')
    # Pass the password too: the CI service database authenticates with scram/md5, and
    # asyncpg.connect() without a password fails with InvalidPasswordError even though
    # the DSN (used by pg_dump/pg_restore via --dbname) carries one. Harmless on a
    # trust-authenticated cluster.
    db_password=test_engine.url.password
    admin=await asyncpg.connect(host='127.0.0.1',port=port,user=test_engine.url.username,password=db_password,database='postgres')
    recovered=None
    try:
        async with test_engine.begin() as c:
            await c.execute(sa.text('CREATE SCHEMA '+schema))
            await c.execute(sa.text('SET LOCAL search_path TO '+schema))
            await c.run_sync(old_schema)
        result=await asyncio.to_thread(subprocess.run,[str(binary/'pg_dump'),'--format=custom','--schema='+schema,
            '--file='+str(archive),'--dbname='+url],env=env,capture_output=True,timeout=20)
        assert result.returncode==0, result.stderr.decode()
        async with test_engine.begin() as c:
            await c.execute(sa.text('SET LOCAL search_path TO '+schema))
            await c.run_sync(upgrade); await c.run_sync(verify)
            async with async_sessionmaker(bind=c,expire_on_commit=False,join_transaction_mode='create_savepoint')() as db:
                db.add(Message(id='post-cutover',room_id='r1',sender_id='owner',content='keep-new-write'))
                await db.commit()
            exported=(await c.execute(sa.text('SELECT id,room_id,sender_id,sender_type,content,msg_type,sender_name,parent_id,created_at FROM messages ORDER BY id'))).all()
        await admin.execute('CREATE DATABASE '+shadow)
        restore_url=test_engine.url.set(drivername='postgresql',database=shadow).render_as_string(hide_password=False)
        result=await asyncio.to_thread(subprocess.run,[str(binary/'pg_restore'),'--no-owner','--no-acl',
            '--dbname='+restore_url,str(archive)],env=env,capture_output=True,timeout=20)
        assert result.returncode==0,result.stderr.decode()
        recovered=await asyncpg.connect(host='127.0.0.1',port=port,user=test_engine.url.username,password=db_password,database=shadow)
        await recovered.execute('SET search_path TO '+schema)
        assert await recovered.fetchval('SELECT COUNT(*) FROM messages')==4
        assert not await recovered.fetchval("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='messages' AND column_name='room_seq'",schema)
        # Quiesced old-compatible export retains synthetic post-cutover writes;
        # production must copy/validate ALL changed tables, not just messages.
        async with recovered.transaction():
            await recovered.execute('DELETE FROM messages')
            await recovered.executemany('INSERT INTO messages(id,room_id,sender_id,sender_type,content,msg_type,sender_name,parent_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[tuple(row) for row in exported])
        assert await recovered.fetchval("SELECT content FROM messages WHERE id='post-cutover'")=='keep-new-write'
        assert [tuple(row) for row in await recovered.fetch('SELECT id,content FROM messages ORDER BY id')]==[(row.id,row.content) for row in exported]
    finally:
        if recovered is not None: await recovered.close()
        # Only our generated shadow database and schema, inside owned /tmp cluster.
        await admin.execute('DROP DATABASE IF EXISTS '+shadow)
        await admin.close()
        async with test_engine.begin() as c: await c.execute(sa.text('DROP SCHEMA IF EXISTS '+schema+' CASCADE'))
