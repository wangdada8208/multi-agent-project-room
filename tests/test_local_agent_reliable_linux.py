import json
import pytest
from local_agent_adapter import LocalAgentAdapter

class FakeWS:
    def __init__(self): self.sent = []
    async def send(self, value): self.sent.append(json.loads(value))

def adapter():
    return LocalAgentAdapter("http://test", None, "bot", "bot", ["mock-cli"], 8765, 30)

@pytest.mark.asyncio
async def test_cancel_receipt_without_cli():
    a = adapter()
    ws = FakeWS()
    await a._handle_message({"type": "task_cancel", "v": 1, "task_id": "t",
                             "delivery_id": "d", "origin_room": "r", "attempt": 1}, ws)
    assert any(m["type"] == "task_cancel_ack" for m in ws.sent)
    await a.http.aclose()

import asyncio
from datetime import datetime, timedelta, timezone

FRAME = {"type": "agent_task", "v": 1, "task_id": "t", "delivery_id": "d",
         "origin_room": "r", "attempt": 1, "content": "run analysis", "message_id": "m"}

async def settle():
    for _ in range(5): await asyncio.sleep(0)

async def grant(a, ws, did="d", attempt=1):
    await a._handle_message({"type": "task_ack_result", "v": 1, "delivery_id": did,
                            "attempt": attempt, "accepted": True,
                            "deadline": (datetime.now(timezone.utc)+timedelta(seconds=60)).isoformat()}, ws)

@pytest.mark.asyncio
async def test_ack_receipt_required_and_duplicate_does_not_execute(monkeypatch):
    a = adapter(); ws = FakeWS(); calls = []
    async def ai(prompt): calls.append(prompt); return "done"
    monkeypatch.setattr(a, "_call_local_ai_async", ai)
    await a._handle_message(FRAME, ws)
    await settle()
    assert not calls and any(m["type"] == "task_ack" for m in ws.sent)
    await a._handle_message(FRAME, ws)
    await grant(a, ws)
    await asyncio.wait_for(a._task_queue.join(), 2)
    assert len(calls) == 1
    await a._handle_message(FRAME, ws)
    await settle()
    assert len(calls) == 1
    assert len([m for m in ws.sent if m["type"] == "message"]) == 1
    await a.http.aclose()

@pytest.mark.asyncio
async def test_cancel_during_execution_reaps_and_suppresses_late_result(monkeypatch):
    a = adapter(); ws = FakeWS(); entered = asyncio.Event(); reaped = asyncio.Event()
    async def ai(prompt):
        entered.set()
        try: await asyncio.Event().wait()
        finally: reaped.set()
    monkeypatch.setattr(a, "_call_local_ai_async", ai)
    await a._handle_message(FRAME, ws); await settle(); await grant(a, ws)
    await asyncio.wait_for(entered.wait(), 2)
    await a._handle_message({**FRAME, "type": "task_cancel"}, ws)
    await asyncio.wait_for(a._task_queue.join(), 2)
    assert reaped.is_set()
    assert not any(m["type"] == "message" for m in ws.sent)
    assert any(m["type"] == "task_cancel_ack" for m in ws.sent)
    await a.http.aclose()

@pytest.mark.asyncio
async def test_bounded_queue_32_and_one_worker(monkeypatch):
    a = adapter(); ws = FakeWS(); entered = asyncio.Event()
    async def ai(prompt): entered.set(); await asyncio.Event().wait()
    monkeypatch.setattr(a, "_call_local_ai_async", ai)
    await a._handle_message(FRAME, ws); await settle(); await grant(a, ws)
    await asyncio.wait_for(entered.wait(), 2)
    for i in range(40):
        await a._handle_message({**FRAME, "delivery_id": f"extra-{i}", "task_id": f"t-{i}"}, ws)
    assert a._task_queue.qsize() == 32
    assert len([m for m in ws.sent if m["type"] == "task_busy"]) == 8
    await a._disconnect_reliable(); await a.http.aclose()

@pytest.mark.asyncio
async def test_resume_uses_persistent_pagination_without_history_http(monkeypatch):
    a = adapter(); ws = FakeWS()
    async def bad_http(*args, **kwargs): raise AssertionError("Must not read recent20")
    monkeypatch.setattr(a.http, "get", bad_http)
    await a._catch_up_missed_messages(ws)
    await a._handle_message({"type": "task_resume_result", "cursor": "next"}, ws)
    assert ws.sent == [{"v": 1, "type": "task_resume", "cursor": ""},
                       {"v": 1, "type": "task_resume", "cursor": "next"}]
    await a.http.aclose()

@pytest.mark.asyncio
async def test_expired_ack_receipt_never_runs(monkeypatch):
    a = adapter(); ws = FakeWS(); calls = []
    async def ai(prompt): calls.append(prompt); return "done"
    monkeypatch.setattr(a, "_call_local_ai_async", ai)
    await a._handle_message(FRAME, ws); await settle()
    await a._handle_message({"type": "task_ack_result", "delivery_id": "d", "attempt": 1,
        "accepted": True, "deadline": (datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()}, ws)
    await asyncio.wait_for(a._task_queue.join(), 2)
    assert not calls
    await a.http.aclose()

@pytest.mark.asyncio
async def test_old_attempt_receipt_cannot_start_new_attempt(monkeypatch):
    a = adapter(); ws = FakeWS(); calls = []
    async def ai(prompt): calls.append(prompt); return "done"
    monkeypatch.setattr(a, "_call_local_ai_async", ai)
    await a._handle_message({**FRAME, "attempt": 2}, ws); await settle()
    await grant(a, ws, attempt=1); await settle()
    assert not calls
    await a._disconnect_reliable(); await a.http.aclose()

@pytest.mark.asyncio
async def test_mock_subprocess_term_kill_wait_and_no_shell(monkeypatch):
    a = adapter(); entered = asyncio.Event(); calls = []
    class Stream:
        async def read(self, size): entered.set(); await asyncio.Event().wait()
    class Proc:
        pid = 123456789
        returncode = None
        stdout = Stream(); stderr = Stream()
        waits = 0
        async def wait(self):
            self.waits += 1
            if self.waits == 1: raise asyncio.TimeoutError()
            self.returncode = -9
            return -9
    proc = Proc()
    async def spawn(*args, **kwargs):
        assert args == (["mock-cli"], "hello;$(bad)", 30)
        proc._mapr_owned_pgid = proc.pid
        return proc
    monkeypatch.setattr("local_agent_reliable._spawn_supervised", spawn)
    monkeypatch.setattr(a, "_signal_process", lambda p, hard=False: calls.append("KILL" if hard else "TERM"))
    work = asyncio.create_task(a._call_local_ai_async("hello;$(bad)"))
    await asyncio.wait_for(entered.wait(), 2)
    work.cancel()
    with pytest.raises(asyncio.CancelledError): await work
    assert calls == ["TERM", "KILL"] and proc.waits == 2
    await a.http.aclose()

@pytest.mark.asyncio
async def test_disconnect_stops_worker_and_does_not_reexecute_uncertain(monkeypatch):
    a = adapter(); ws = FakeWS(); calls = []
    async def ai(prompt): calls.append(prompt); await asyncio.Event().wait()
    monkeypatch.setattr(a, "_call_local_ai_async", ai)
    await a._handle_message(FRAME, ws); await settle(); await grant(a, ws); await settle()
    await a._disconnect_reliable()
    await a._handle_message({**FRAME, "attempt": 2}, ws); await settle()
    assert len(calls) == 1
    assert a._active_execution is None
    await a.http.aclose()

@pytest.mark.asyncio
async def test_legacy_receiver_queues_execution_and_remains_responsive(monkeypatch):
    a = adapter(); ws = FakeWS(); entered = asyncio.Event(); stopped = asyncio.Event()
    async def ai(prompt):
        entered.set()
        try: await asyncio.Event().wait()
        finally: stopped.set()
    monkeypatch.setattr(a, "_call_local_ai_async", ai)
    await asyncio.wait_for(a._receive_message({"type": "agent_task", "task_id": "legacy",
        "message_id": "lm", "origin_room": "r", "content": "analyze code"}, ws), 1)
    await asyncio.wait_for(entered.wait(), 2)
    await a._receive_message({"type": "task_cancel", "task_id": "legacy"}, ws)
    await asyncio.wait_for(a._task_queue.join(), 2)
    assert stopped.is_set() and not any(m["type"] == "message" for m in ws.sent)
    await a.http.aclose()

@pytest.mark.asyncio
async def test_exited_leader_still_cleans_owned_process_group(monkeypatch):
    a = adapter(); calls = []
    class Proc:
        pid = 123456789
        returncode = 0
        async def wait(self): calls.append("wait"); return 0
    monkeypatch.setattr(a, "_signal_process", lambda p, hard=False: calls.append("KILL" if hard else "TERM"))
    await a._reap_process(Proc())
    assert "TERM" in calls and "KILL" in calls and "wait" in calls
    await a.http.aclose()

@pytest.mark.asyncio
async def test_repeated_cancel_and_stop_wait_for_single_protected_cleanup(monkeypatch):
    a = adapter(); ws = FakeWS(); entered = asyncio.Event(); cleanup = asyncio.Event(); release = asyncio.Event(); calls=[]
    class Stream:
        async def read(self, size): entered.set(); await asyncio.Event().wait()
    class Proc:
        pid = 123456789
        returncode = None
        stdout = Stream(); stderr = Stream()
        async def wait(self):
            cleanup.set()
            await release.wait()
            self.returncode = -15
            calls.append("wait")
            return -15
    proc = Proc()
    async def spawn(*args, **kwargs): return proc
    monkeypatch.setattr("local_agent_reliable._spawn_supervised", spawn)
    monkeypatch.setattr(a, "_signal_process", lambda p, hard=False: calls.append("KILL" if hard else "TERM"))
    await a._handle_message(FRAME, ws); await settle(); await grant(a, ws)
    await asyncio.wait_for(entered.wait(), 2)
    first = asyncio.create_task(a._handle_message({**FRAME, "type": "task_cancel"}, ws))
    await asyncio.wait_for(cleanup.wait(), 2)
    second = asyncio.create_task(a._handle_message({**FRAME, "type": "task_cancel"}, ws))
    a.stop()
    await settle()
    assert not any(m["type"] == "task_cancel_ack" for m in ws.sent)
    release.set()
    await asyncio.wait_for(asyncio.gather(first, second, a._disconnect_reliable()), 3)
    assert "wait" in calls and calls.count("TERM") == 1 and calls.count("KILL") == 1
    assert a._active_execution is None
    await a.http.aclose()

def test_only_spawned_session_pgid_can_be_signaled(monkeypatch):
    a = adapter(); calls = []
    class Proc:
        pid = 123456789
        returncode = 0
    proc = Proc()
    monkeypatch.setattr("local_agent_reliable.os.killpg", lambda pid, sig: calls.append((pid, sig)))
    a._signal_process(proc)
    assert calls == []
    proc._mapr_owned_pgid = proc.pid
    a._signal_process(proc, hard=True)
    assert calls == []  # A stale numeric PGID is never a signal capability.

@pytest.mark.asyncio
async def test_disconnect_before_ack_reoffers_only_unstarted_work(monkeypatch):
    a = adapter(); old = FakeWS(); new = FakeWS(); calls = []
    async def ai(prompt): calls.append(prompt); return 'done'
    monkeypatch.setattr(a, '_call_local_ai_async', ai)
    try:
        await a._handle_message(FRAME, old); await settle()
        assert any(f['type'] == 'task_ack' for f in old.sent)
        assert a._deliveries['d']['execution_started'] is False
        await a._disconnect_reliable()
        assert 'd' not in a._deliveries and calls == []
        await a._handle_message({**FRAME,'attempt':2}, new); await settle()
        await grant(a, new, attempt=1); await settle()
        assert calls == []  # Old ACK cannot authorize the replacement attempt.
        await grant(a, new, attempt=2)
        await asyncio.wait_for(a._task_queue.join(),2)
        assert len(calls) == 1 and a._deliveries['d']['execution_started'] is True
        assert len([f for f in new.sent if f['type']=='message']) == 1
    finally:
        await a._disconnect_reliable(); await a.http.aclose()


@pytest.mark.asyncio
async def test_owner_cancel_before_ack_remains_fenced_after_reconnect(monkeypatch):
    a = adapter(); ws = FakeWS(); calls = []
    async def ai(prompt): calls.append(prompt); return 'must not execute'
    monkeypatch.setattr(a, '_call_local_ai_async', ai)
    try:
        await a._handle_message(FRAME, ws); await settle()
        await a._handle_message({**FRAME,'type':'task_cancel'}, ws)
        await a._disconnect_reliable()
        assert 't' in a._canceled_tasks and 'd' in a._deliveries
        await a._handle_message({**FRAME,'attempt':2}, ws); await settle()
        await grant(a, ws, attempt=2); await settle()
        assert calls == []
    finally:
        await a._disconnect_reliable(); await a.http.aclose()

@pytest.mark.asyncio
async def test_higher_offer_before_ack_replaces_unstarted_attempt_and_ignores_old_denial(monkeypatch):
    a = adapter(); ws = FakeWS(); calls = []
    async def ai(prompt): calls.append(prompt); return 'done'
    monkeypatch.setattr(a, '_call_local_ai_async', ai)
    try:
        await a._handle_message(FRAME, ws); await settle()
        old = a._deliveries['d']
        assert old['state'] == 'running' and old['execution_started'] is False
        await a._handle_message({**FRAME,'attempt':2}, ws); await settle()
        assert a._deliveries['d'] is not old
        assert a._deliveries['d']['data']['attempt'] == 2
        await a._handle_message({'type':'error','code':'delivery_denied','delivery_id':'d','attempt':1}, ws)
        await grant(a, ws, attempt=1); await settle()
        assert calls == []
        await grant(a, ws, attempt=2)
        await asyncio.wait_for(a._task_queue.join(),2)
        assert len(calls) == 1
        assert len([f for f in ws.sent if f['type']=='message']) == 1
    finally:
        await a._disconnect_reliable(); await a.http.aclose()


@pytest.mark.asyncio
async def test_denial_without_attempt_from_legacy_hub_still_fails_closed(monkeypatch):
    a = adapter(); ws = FakeWS(); calls = []
    async def ai(prompt): calls.append(prompt); return 'must not execute'
    monkeypatch.setattr(a, '_call_local_ai_async', ai)
    try:
        await a._handle_message(FRAME, ws); await settle()
        await a._handle_message({'type':'error','code':'delivery_denied','delivery_id':'d'}, ws)
        await grant(a, ws); await settle()
        assert calls == [] and a._deliveries['d']['state']=='canceled'
    finally:
        await a._disconnect_reliable(); await a.http.aclose()
