"""Real isolated CLI processes; all signal targets are this test's recorded PIDs.

Artifacts live under /tmp. Linux start-time tokens guard every fallback signal.
Mac portability of the implementation is separate from Linux E2E evidence.
"""
import asyncio
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

import pytest

ROOT = Path(__file__).resolve().parents[1]
CLI = r'''
import json,os,signal,subprocess,sys,time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(90)'])
with open(sys.argv[1]+'.tmp', 'w') as f:
    json.dump({'cli':os.getpid(),'child':child.pid,'anchor':os.getppid(),'group':os.getpgrp()},f)
os.replace(sys.argv[1]+'.tmp',sys.argv[1])
time.sleep(90)
'''
ADAPTER = r'''
import asyncio,sys
from local_agent_adapter import LocalAgentAdapter
async def run():
    a=LocalAgentAdapter('http://unused',None,'e2e','e2e',[sys.executable,sys.argv[1],sys.argv[2]],8765,10)
    try: print(await a._call_local_ai_async('synthetic prompt'),flush=True)
    except RuntimeError: print('execution uncertain',flush=True)
    finally: await a.http.aclose()
asyncio.run(run())
'''

def identity(pid):
    try:
        data=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
        return data[19],data[0]
    except FileNotFoundError:
        return None


def running(pid, token):
    current=identity(pid)
    return bool(current and current[0]==token and current[1] != 'Z')


def wait_until(predicate, timeout=6):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if predicate(): return True
        time.sleep(.03)
    return predicate()


@pytest.mark.skipif(sys.platform!='linux',reason='Linux /proc PID identities for real E2E')
def test_adapter_sigkill_cleans_live_cli_tree(reap_only_test_descendants):
    with tempfile.TemporaryDirectory(prefix='mapr-cli-e2e-',dir='/tmp') as directory:
        directory=Path(directory);cli=directory/'cli.py';cli.write_text(CLI)
        manifest=directory/'pids.json';driver=directory/'adapter.py';driver.write_text(ADAPTER)
        env={**os.environ,'PYTHONPATH':str(ROOT),'PYTHONDONTWRITEBYTECODE':'1'}
        adapter=subprocess.Popen([sys.executable,str(driver),str(cli),str(manifest)],cwd=directory,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        sentinel=subprocess.Popen([sys.executable,'-c','import time; time.sleep(90)'],start_new_session=True)
        sentinel_token=identity(sentinel.pid)[0]
        owned={}
        try:
            assert wait_until(manifest.exists), 'CLI did not start'
            data=json.loads(manifest.read_text())
            record_tree(data,reap_only_test_descendants)
            for name in ('cli','child'):
                pid=data[name];owned[pid]=identity(pid)[0]
            assert all(running(pid,token) for pid,token in owned.items())
            adapter.kill();adapter.wait(timeout=3)
            assert wait_until(lambda:not any(running(pid,token) for pid,token in owned.items())), 'CLI survived adapter SIGKILL'
            assert running(sentinel.pid,sentinel_token), 'Unrelated process was terminated'
        finally:
            if running(sentinel.pid,sentinel_token):sentinel.kill()
            sentinel.wait(timeout=3)
            if adapter.poll() is None: adapter.kill()
            adapter.wait(timeout=3)
            # Whitelist only the two explicitly created CLI processes, and check
            # their birth tokens before each signal; never scan or kill a group.
            for pid,token in owned.items():
                if running(pid,token):
                    try: os.kill(pid,signal.SIGKILL)
                    except ProcessLookupError: pass

@pytest.fixture(autouse=True)
def reap_only_test_descendants():
    """Adopt orphan test grandchildren on Linux, then reap recorded PIDs only."""
    if sys.platform!='linux':
        yield [];return
    import ctypes
    libc=ctypes.CDLL(None,use_errno=True)
    original=ctypes.c_int()
    assert libc.prctl(37,ctypes.byref(original),0,0,0)==0  # GET_CHILD_SUBREAPER
    assert libc.prctl(36,1,0,0,0)==0
    records=[]
    try:
        yield records
    finally:
        for pid,token in records:
            if running(pid,token):
                try:os.kill(pid,signal.SIGKILL)
                except ProcessLookupError:pass
        deadline=time.monotonic()+3
        for pid,token in records:
            while identity(pid) and identity(pid)[0]==token and time.monotonic()<deadline:
                try:
                    waited,_=os.waitpid(pid,os.WNOHANG)
                    if waited:break
                except ChildProcessError:pass
                time.sleep(.02)
        assert libc.prctl(36,original.value,0,0,0)==0


def record_tree(data,records):
    # Manifest comes from the synthetic child code, never a PID registry.
    anchor=data['anchor']
    stat=Path(f'/proc/{anchor}/stat').read_text().rsplit(')',1)[1].split()
    supervisor=int(stat[1])
    pids=[data['cli'],data['child'],anchor,supervisor]
    assert data['group']==anchor
    for pid in pids:
        token=identity(pid)
        assert token and token[1]!='Z'
        records.append((pid,token[0]))
    return supervisor


@pytest.mark.skipif(sys.platform!='linux',reason='Linux PID birth tokens for E2E cleanup')
@pytest.mark.parametrize('failure',['supervisor_kill','adapter_terminate','timeout','normal_exit'])
def test_supervision_failure_modes(failure,reap_only_test_descendants):
    with tempfile.TemporaryDirectory(prefix='mapr-cli-e2e-',dir='/tmp') as directory:
        directory=Path(directory)
        cli=directory/'cli.py'
        code=CLI
        if failure=='normal_exit':
            code=code.rsplit('time.sleep(90)',1)[0]+"print('normal output',flush=True)\n"
        cli.write_text(code)
        manifest=directory/'pids.json'
        driver=directory/'adapter.py'
        driver.write_text(ADAPTER.replace('8765,10)', '8765,1)' if failure=='timeout' else '8765,10)'))
        env={**os.environ,'PYTHONPATH':str(ROOT),'PYTHONDONTWRITEBYTECODE':'1'}
        adapter=subprocess.Popen([sys.executable,str(driver),str(cli),str(manifest)],cwd=directory,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            assert wait_until(manifest.exists)
            data=json.loads(manifest.read_text())
            if failure=='normal_exit':
                # CLI may already have exited; record the live grandchild's
                # exact birth token before observing final cleanup.
                pid=data['child'];token=identity(pid)
                if token:reap_only_test_descendants.append((pid,token[0]))
            else:
                supervisor=record_tree(data,reap_only_test_descendants)
                if failure=='supervisor_kill':
                    token=dict(reap_only_test_descendants)[supervisor]
                    assert running(supervisor,token)
                    os.kill(supervisor,signal.SIGKILL)
                elif failure=='adapter_terminate':
                    adapter.terminate()
            stdout,stderr=adapter.communicate(timeout=9)
            if failure=='timeout':assert b'AI timed out' in stdout
            if failure=='supervisor_kill':assert b'execution uncertain' in stdout
            assert b'Traceback' not in stderr
            assert wait_until(lambda:not any(running(pid,token) for pid,token in reap_only_test_descendants))
        finally:
            if adapter.poll() is None:adapter.kill()
            adapter.communicate(timeout=3)


@pytest.mark.asyncio
async def test_real_cancel_and_bounded_output(reap_only_test_descendants):
    from local_agent_adapter import LocalAgentAdapter
    with tempfile.TemporaryDirectory(prefix='mapr-cli-e2e-',dir='/tmp') as directory:
        directory=Path(directory);cli=directory/'cli.py';cli.write_text(CLI)
        manifest=directory/'pids.json'
        a=LocalAgentAdapter('http://unused',None,'e2e','e2e',[sys.executable,str(cli),str(manifest)],8765,10)
        task=asyncio.create_task(a._call_local_ai_async('synthetic'))
        try:
            deadline=time.monotonic()+4
            while not manifest.exists() and time.monotonic()<deadline:
                await asyncio.sleep(.02)
            assert manifest.exists()
            if sys.platform=='linux':record_tree(json.loads(manifest.read_text()),reap_only_test_descendants)
            task.cancel();task.cancel()
            with pytest.raises(asyncio.CancelledError):await asyncio.wait_for(task,6)
            assert not any(running(pid,token) for pid,token in reap_only_test_descendants)
            a.command=[sys.executable,'-c',"import sys;sys.stdout.write('x'*200000);sys.stderr.write('Bearer synthetic-private-token '*20000)"]
            assert len(await a._call_local_ai_async('ignored'))==2000
        finally:
            if not task.done():task.cancel();await asyncio.gather(task,return_exceptions=True)
            await a.http.aclose()


@pytest.mark.asyncio
async def test_sync_api_stderr_secret_not_logged_or_returned(capsys):
    from local_agent_adapter import LocalAgentAdapter
    a=LocalAgentAdapter('http://unused',None,'e2e','e2e',[sys.executable,'-c',"import sys;sys.stderr.write('Bearer synthetic-private-token');sys.exit(1)"],8765,5)
    try:
        result=await asyncio.to_thread(a._call_local_ai,'ignored')
        assert result=='[e2e] AI command failed.'
        captured=capsys.readouterr()
        assert 'synthetic-private-token' not in captured.out+captured.err
    finally:await a.http.aclose()


@pytest.mark.asyncio
async def test_concurrent_direct_calls_serialize_and_stopped_call_never_starts(monkeypatch):
    from local_agent_adapter import LocalAgentAdapter
    a=LocalAgentAdapter('http://unused',None,'e2e','e2e',['fake'],8765,5)
    entered=asyncio.Event();release=asyncio.Event();calls=[]
    async def fake(prompt):
        calls.append(prompt);entered.set();await release.wait();return 'done'
    monkeypatch.setattr(a,'_call_supervised_ai',fake)
    first=asyncio.create_task(a._call_local_ai_async('first'))
    second=asyncio.create_task(a._call_local_ai_async('second'))
    try:
        await entered.wait();assert calls==['first']
        a._reliable_closing=True;release.set()
        await asyncio.gather(first,second)
        assert calls==['first']
    finally:await a.http.aclose()

@pytest.mark.skipif(sys.platform!='linux',reason='Linux PID birth tokens for bounded negative E2E')
@pytest.mark.parametrize('escape',['both_helpers_killed','setsid_child'])
def test_physical_containment_limits_are_explicit(escape,reap_only_test_descendants):
    with tempfile.TemporaryDirectory(prefix='mapr-cli-e2e-',dir='/tmp') as directory:
        directory=Path(directory);cli=directory/'cli.py'
        code=CLI
        if escape=='setsid_child':
            code=code.replace("time.sleep(90)'])", "time.sleep(90)'],start_new_session=True)")
        cli.write_text(code)
        manifest=directory/'pids.json';driver=directory/'adapter.py';driver.write_text(ADAPTER)
        env={**os.environ,'PYTHONPATH':str(ROOT),'PYTHONDONTWRITEBYTECODE':'1'}
        adapter=subprocess.Popen([sys.executable,str(driver),str(cli),str(manifest)],cwd=directory,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            assert wait_until(manifest.exists)
            data=json.loads(manifest.read_text())
            supervisor=record_tree(data,reap_only_test_descendants)
            if escape=='both_helpers_killed':
                for pid in (supervisor,data['anchor']):
                    token=dict(reap_only_test_descendants)[pid]
                    if running(pid,token):os.kill(pid,signal.SIGKILL)
            adapter.kill();adapter.wait(timeout=3)
            # With all watchdogs gone, or outside their owned group, cleanup
            # cannot physically be promised. This is a bounded negative test;
            # the fixture signals/reaps only this exact birth-token whitelist.
            time.sleep(2.5 if escape=='setsid_child' else .2)
            pid=data['child'];token=dict(reap_only_test_descendants)[pid]
            assert running(pid,token)
            if escape=='setsid_child':
                assert not running(data['cli'],dict(reap_only_test_descendants)[data['cli']])
        finally:
            if adapter.poll() is None:adapter.kill()
            adapter.wait(timeout=3)


@pytest.mark.asyncio
async def test_cancellation_during_spawn_closes_exact_owned_control(monkeypatch):
    from local_agent_adapter import LocalAgentAdapter
    from local_agent_reliable import _spawn_supervised
    from unittest.mock import AsyncMock
    a=LocalAgentAdapter('http://unused',None,'e2e','e2e',['fake'],8765,5)
    entered=asyncio.Event();release=asyncio.Event();closed=[]
    class Control:
        def close(self):closed.append(True)
    class Proc:
        _mapr_control=Control()
        wait=AsyncMock(return_value=125)
    proc=Proc()
    async def spawn(*args):
        entered.set();await release.wait();return proc
    monkeypatch.setattr('local_agent_reliable._spawn_supervised',spawn)
    task=asyncio.create_task(a._call_local_ai_async('ignored'))
    await entered.wait();task.cancel();await asyncio.sleep(0)
    assert not task.done()
    release.set()
    with pytest.raises(asyncio.CancelledError):await task
    assert closed and proc.wait.await_count==1
    await a.http.aclose()


@pytest.mark.asyncio
async def test_cleanup_failure_never_sends_cancel_ack(monkeypatch):
    from local_agent_adapter import LocalAgentAdapter
    a=LocalAgentAdapter('http://unused',None,'e2e','e2e',['fake'],8765,5)
    entered=asyncio.Event()
    async def execution():
        entered.set()
        try:await asyncio.Future()
        except asyncio.CancelledError:raise RuntimeError('cleanup unavailable')
    class WS:
        sent=[]
        async def send(self,value):self.sent.append(json.loads(value))
    ws=WS();a._active_delivery='d';a._active_execution=asyncio.create_task(execution())
    a._deliveries['d']={'state':'running','ack':asyncio.Event()}
    await entered.wait()
    with pytest.raises(RuntimeError,match='could not be confirmed'):
        await a._reliable_message({'type':'task_cancel','task_id':'t','delivery_id':'d','origin_room':'r','attempt':1},ws)
    assert not ws.sent
    await a.http.aclose()


@pytest.mark.asyncio
async def test_cleanup_drains_output_before_wait_without_returncode():
    from local_agent_reliable import _stop_supervised
    finished=asyncio.Event();closed=[]
    class Stream:
        async def read(self,size):
            finished.set()
            return b''
    class Control:
        def close(self):closed.append(True)
    class Proc:
        _mapr_control=Control()
        stdout=Stream()
        stderr=None
        async def wait(self):
            await finished.wait()
            return 125
    await asyncio.wait_for(_stop_supervised(Proc()),1)
    assert closed==[True] and finished.is_set()
