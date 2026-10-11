"""Bounded WS executor and per-invocation POSIX CLI lifetime supervision.

Local implementation design (2026-10-11, within the user's adapter-only scope):
Adapter -> temporary supervisor -> session/group anchor -> CLI and descendants.
A private socket EOF cancels work when the adapter exits, including SIGKILL.
An anchor-side private pipe EOF covers supervisor death; both helpers enforce
monotonic wall-clock limits. No service, daemon, root, registry or PID file.
The live/unreaped anchor PID reserves the group's identity until its supervisor
has sent the final group signal. The adapter NEVER signals a stale numeric PGID.
Only the fresh, single-threaded stdlib helper forks (not the async adapter).
Control/config FDs are close-on-exec and excluded from CLI inheritance. Command
and prompt go to the supervisor over the private socket, not helper argv/logs.

POSIX Linux/macOS API design; real tests on Linux do not prove macOS execution.
Not containment: descendants can escape using setsid/setpgid; killing BOTH
helpers, stopping them, uninterruptible kernel sleep, or machine failure can
prevent cleanup. SIGKILL cannot be handled. External effects cannot be undone.
A restart never scans/kills stored PIDs or replays uncertain executions. Strong
containment would need a separately approved OS service/cgroup/sandbox design.
"""
import asyncio
import json
import os
import signal
import select
import socket
import subprocess
import sys
import time
import math
from pathlib import Path
from datetime import datetime, timezone

class ReliableAgentMixin:
    def _init_reliable(self):
        self._reliable_closing = False
        self._task_queue = asyncio.Queue(maxsize=32)
        self._task_worker = None
        self._deliveries = {}
        self._canceled_tasks = set()
        self._active_execution = None
        self._active_delivery = None
        self._reliable_ws = None
        self._cleanup_tasks = set()
        self._shutdown_task = None
        self._cli_lock = asyncio.Lock()

    def _control_frame(self, data, kind):
        return {"v": 1, "type": kind, "task_id": data["task_id"],
                "delivery_id": data["delivery_id"], "attempt": data["attempt"],
                "target_room": data["origin_room"]}

    async def _reliable_message(self, data, ws):
        kind = data.get("type")
        did = data.get("delivery_id")
        if kind == "task_resume_result":
            if data.get("cursor"):
                await ws.send(json.dumps({"v": 1, "type": "task_resume", "cursor": data["cursor"]}))
            return True
        if kind in {"task_ack_result", "task_lease_result"}:
            state = self._deliveries.get(did)
            if state and data.get("attempt") == state["data"]["attempt"]:
                if data.get("accepted"):
                    state["deadline"] = data.get("deadline")
                    state["ack"].set()
            return True
        if kind == "task_result_ack":
            state = self._deliveries.get(did)
            if state:
                state["state"] = "done"
            return True
        if kind in {"task_cancel", "task_uncertain"} or (kind == "error" and data.get("code") == "delivery_denied"):
            state = self._deliveries.get(did)
            if (kind == "error" and state and type(data.get("attempt")) is int
                    and data["attempt"] != state["data"]["attempt"]):
                return True  # A refused superseded ACK cannot stop its replacement.
            if kind == "task_cancel" and data.get("task_id"):
                self._canceled_tasks.add(data["task_id"])
            state = self._deliveries.get(did)
            if state:
                state["state"] = "canceled"
                state["ack"].set()
                if self._active_delivery == did and self._active_execution:
                    await self._cancel_active_execution()
            if kind == "task_cancel" and getattr(self, "_active_legacy_task", None) == data.get("task_id") and self._active_execution:
                await self._cancel_active_execution()
            if kind == "task_cancel" and data.get("delivery_id"):
                await ws.send(json.dumps(self._control_frame(data, "task_cancel_ack")))
            return True
        if kind != "agent_task" or not data.get("delivery_id") or data.get("v") != 1:
            return False
        if not all(data.get(k) for k in ("task_id", "origin_room", "attempt")):
            return True
        self._reliable_ws = ws
        existing = self._deliveries.get(did)
        if existing:
            higher = data["attempt"] > existing["data"]["attempt"]
            if existing["state"] == "queued" and higher:
                existing["data"].update(data)
                return True
            if (higher and existing.get("execution_started", True) is False
                    and data["task_id"] not in self._canceled_tasks):
                if self._active_delivery == did and self._active_execution:
                    await self._cancel_active_execution()
                # Replace the object: the old worker can only mutate its old
                # state while unwinding, never the newly queued attempt.
                del self._deliveries[did]
            else:
                if existing["state"] == "running" and data["attempt"] == existing["data"]["attempt"]:
                    await ws.send(json.dumps(self._control_frame(data, "task_ack")))
                return True
        if self._task_queue.full() or len(self._deliveries) >= 4096:
            await ws.send(json.dumps({"v": 1, "type": "task_busy", "delivery_id": did}))
            return True
        self._reliable_closing = False
        self._deliveries[did] = {"data": dict(data), "state": "queued", "ack": asyncio.Event(), "deadline": None, "execution_started": False}
        self._task_queue.put_nowait(did)
        if not self._task_worker or self._task_worker.done():
            self._task_worker = asyncio.create_task(self._reliable_worker())
        return True

    async def _receive_message(self, data, ws):
        if not isinstance(data, dict):
            return
        if await self._reliable_message(data, ws):
            return
        # Keep old chat/dialogue frames on the same single execution worker.
        if data.get("type") not in {"message", "agent_task", "agent_dialogue_message", "agent_dialogue_ended"}:
            return
        if self._task_queue.full():
            await ws.send(json.dumps({"type": "task_busy"}))
            return
        self._reliable_closing = False
        self._task_queue.put_nowait((data, ws))
        if not self._task_worker or self._task_worker.done():
            self._task_worker = asyncio.create_task(self._reliable_worker())

    async def _run_local_ai(self, prompt):
        # Preserve legacy callers' injectable synchronous test hook; real runtime uses cancellable subprocess.
        if "_call_local_ai" in self.__dict__:
            return await asyncio.to_thread(self._call_local_ai, prompt)
        return await self._call_local_ai_async(prompt)

    async def _reliable_worker(self):
        while not self._reliable_closing and not self._task_queue.empty():
            did = await self._task_queue.get()
            if isinstance(did, tuple):
                data, ws = did
                self._active_delivery = data.get("delivery_id")
                self._active_legacy_task = data.get("task_id") or (data.get("message") or {}).get("task_id")
                if self._active_legacy_task in self._canceled_tasks:
                    self._task_queue.task_done()
                    self._active_delivery = None
                    self._active_legacy_task = None
                    continue
                self._active_execution = asyncio.create_task(self._handle_message(data, ws))
                try:
                    await self._active_execution
                except asyncio.CancelledError:
                    pass
                except Exception:
                    pass
                finally:
                    self._active_execution = None
                    self._active_delivery = None
                    self._active_legacy_task = None
                    self._task_queue.task_done()
                continue
            state = self._deliveries[did]
            try:
                if state["state"] != "queued":
                    continue
                state["state"] = "running"
                self._active_delivery = did
                self._active_execution = asyncio.create_task(self._execute_delivery(state))
                try:
                    await self._active_execution
                except asyncio.CancelledError:
                    state["state"] = "canceled"
                except Exception:
                    # No exception strings: URLs and CLI errors may contain credentials.
                    state["state"] = "uncertain"
                finally:
                    self._active_execution = None
                    self._active_delivery = None
            finally:
                self._task_queue.task_done()

    def _lease_valid(self, state):
        if not state.get("deadline"):
            return False
        return datetime.fromisoformat(state["deadline"]) > datetime.now(timezone.utc)

    async def _heartbeat_delivery(self, state):
        while state["state"] == "running":
            await asyncio.sleep(10)
            if not self._lease_valid(state):
                if self._active_execution and not self._active_execution.cancelling():
                    self._active_execution.cancel()
                return
            await self._reliable_ws.send(json.dumps(self._control_frame(state["data"], "task_lease")))

    async def _execute_delivery(self, state):
        data = state["data"]
        await self._reliable_ws.send(json.dumps(self._control_frame(data, "task_ack")))
        # Never run merely because the ACK was sent: receipt must be committed server-side.
        await asyncio.wait_for(state["ack"].wait(), timeout=15)
        if state["state"] != "running" or not self._lease_valid(state):
            return
        heartbeat = asyncio.create_task(self._heartbeat_delivery(state))
        try:
            progress = self._control_frame(data, "task_progress")
            progress.update(phase="running", percent=0)
            await self._reliable_ws.send(json.dumps(progress))
            state["execution_started"] = True  # Conservatively fence before any CLI spawn.
            response = await self._call_local_ai_async(self._build_prompt(data.get("content", "")))
            if state["state"] != "running" or not self._lease_valid(state):
                return
            frame = self._control_frame(data, "message")
            frame.update(content=response, msg_type="report", parent_id=data.get("message_id"))
            await self._reliable_ws.send(json.dumps(frame))
            state["state"] = "sent"
        finally:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)

    async def _await_protected(self, future):
        # Cleanup must finish even if cancel, stop, and event-loop shutdown race.
        while not future.done():
            try:
                await asyncio.shield(future)
            except asyncio.CancelledError:
                continue
        return future.result()

    async def _cancel_active_execution(self):
        task = self._active_execution
        if task is None:
            return
        if not task.done() and not task.cancelling():
            task.cancel()
        results = await self._await_protected(asyncio.gather(task, return_exceptions=True))
        if any(isinstance(result, Exception) for result in results):
            raise RuntimeError("CLI cleanup could not be confirmed")

    def _signal_process(self, proc, hard=False):
        # Cancellation is an EOF on an owned capability, never a numeric PID.
        control = getattr(proc, "_mapr_control", None)
        if control is not None:
            control.close()
            return
        # A pid/pgid field on a process object is NOT a lifetime capability.
        # Fail closed for unmarked, exited or injected process objects.

    async def _cleanup_process_group(self, proc):
        if hasattr(proc, "_mapr_control"):
            # Supervisor owns TERM/KILL and its child wait. Never kill it merely
            # because output collection or adapter cancellation is racing.
            await _stop_supervised(proc)
            return
        # Compatibility cleanup for injected process fixtures only.
        async def discard(stream):
            while await stream.read(4096):
                pass
        drains = [asyncio.create_task(discard(stream)) for stream in
                  (getattr(proc, "stdout", None), getattr(proc, "stderr", None)) if stream is not None]
        try:
            self._signal_process(proc)
            hard_sent = False
            try:
                await asyncio.wait_for(proc.wait(), timeout=2)
            except asyncio.TimeoutError:
                self._signal_process(proc, hard=True)
                hard_sent = True
            finally:
                if not hard_sent:
                    await asyncio.sleep(0.1)
                    self._signal_process(proc, hard=True)
            await proc.wait()
        finally:
            for drain in drains:
                drain.cancel()
            await asyncio.gather(*drains, return_exceptions=True)

    async def _reap_process(self, proc):
        cleanup = getattr(proc, "_mapr_cleanup_task", None)
        if cleanup is None:
            cleanup = asyncio.create_task(self._cleanup_process_group(proc))
            proc._mapr_cleanup_task = cleanup
            self._cleanup_tasks.add(cleanup)
            cleanup.add_done_callback(self._cleanup_tasks.discard)
        await self._await_protected(cleanup)

    async def _call_local_ai_async(self, prompt):
        # Covers direct callers as well as the existing single WS worker.
        async with self._cli_lock:
            if self._reliable_closing:
                return f"[{self.agent_name}] AI execution stopped."
            return await self._call_supervised_ai(prompt)

    async def _call_supervised_ai(self, prompt):
        if not self.command:
            return f"[{self.agent_name}] No AI command configured."
        spawn = asyncio.create_task(_spawn_supervised(self.command, prompt, self.ai_timeout))
        proc = None
        try:
            proc = await asyncio.shield(spawn)
            async def drain(stream):
                result = bytearray()
                while True:
                    chunk = await stream.read(4096)
                    if not chunk:
                        break
                    if len(result) < 8192:
                        result.extend(chunk[:8192-len(result)])
                return bytes(result)
            async def collect():
                stdout, _ = await asyncio.gather(drain(proc.stdout), drain(proc.stderr))
                await proc.wait()
                return stdout
            output = await asyncio.wait_for(collect(), timeout=self.ai_timeout + SUPERVISOR_START_SECONDS + TERM_GRACE_SECONDS + 2)
            if proc.returncode < 0 or proc.returncode == 126:
                raise RuntimeError("CLI supervisor exited unexpectedly")
            if proc.returncode == 124:
                return f"[{self.agent_name}] AI timed out."
            if proc.returncode != 0:
                return f"[{self.agent_name}] AI command failed."
            return output.decode("utf-8", errors="replace").strip()[:2000] or "(No response)"
        except asyncio.CancelledError:
            if proc is None:
                proc = await self._await_protected(spawn)
            await self._reap_process(proc)
            raise
        except asyncio.TimeoutError:
            if proc:
                await self._reap_process(proc)
            return f"[{self.agent_name}] AI timed out."
        except Exception:
            if proc:
                await self._reap_process(proc)
            return f"[{self.agent_name}] AI command failed."
        finally:
            if proc is not None and hasattr(proc, "_mapr_control"):
                proc._mapr_control.close()

    async def _disconnect_reliable(self):
        # An execution may have performed external work: never queue it again automatically.
        self._reliable_closing = True
        await self._cancel_active_execution()
        if self._task_worker:
            self._task_worker.cancel()
            await asyncio.gather(self._task_worker, return_exceptions=True)
        if self._cleanup_tasks:
            await self._await_protected(asyncio.gather(*self._cleanup_tasks, return_exceptions=True))
        for did, state in list(self._deliveries.items()):
            if state["state"] == "queued" or (
                state.get("execution_started", True) is False
                and state["data"]["task_id"] not in self._canceled_tasks
            ):
                # Awaiting ACK is not an executed/uncertain action. Accept a
                # fresh DB offer after reconnect, then require its committed ACK.
                # Older/unknown state stays fenced by the conservative default.
                del self._deliveries[did]
            elif state["state"] in {"running", "sent"}:
                state["state"] = "uncertain"
        while not self._task_queue.empty():
            self._task_queue.get_nowait()
            self._task_queue.task_done()

    async def astop(self):
        self._running = False
        self._reliable_closing = True
        await self._disconnect_reliable()


SUPERVISOR_START_SECONDS = 5.0
TERM_GRACE_SECONDS = 2.0
CONFIG_LIMIT = 1024 * 1024


async def _stop_supervised(proc):
    """Close only our capability, draining pipes while the owner cleans up."""
    proc._mapr_control.close()
    async def discard(stream):
        while await stream.read(4096):
            pass
    drains = [asyncio.create_task(discard(stream)) for stream in
              (getattr(proc, "stdout", None), getattr(proc, "stderr", None))
              if stream is not None]
    try:
        code = await asyncio.wait_for(proc.wait(), SUPERVISOR_START_SECONDS + TERM_GRACE_SECONDS + 2)
        # Older injected Proc fixtures expose only wait(), not returncode.
        reported = getattr(proc, "returncode", None)
        if reported is not None:
            code = reported
        if not isinstance(code, int) or code < 0 or code == 126:
            raise RuntimeError("CLI cleanup could not be confirmed")
    except asyncio.TimeoutError:
        raise RuntimeError("CLI cleanup could not be confirmed") from None
    finally:
        for drain in drains:
            drain.cancel()
        await asyncio.gather(*drains, return_exceptions=True)


async def _spawn_supervised(command, prompt, timeout):
    """Fresh Python helper, no shell, with a single private parent capability."""
    if os.name != "posix" or not math.isfinite(float(timeout)) or not 0 < timeout <= 86400:
        raise ValueError("Unsupported CLI lifecycle configuration")
    parent, child = socket.socketpair()
    parent.setblocking(False)
    proc = None
    try:
        config = json.dumps({"command": list(command) + [prompt], "timeout": timeout}).encode() + b"\n"
        if len(config) > CONFIG_LIMIT:
            raise ValueError("CLI input exceeds limit")
        proc = await asyncio.create_subprocess_exec(
            sys.executable, str(Path(__file__).resolve()), "--mapr-supervisor", str(child.fileno()),
            pass_fds=(child.fileno(),), stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True, close_fds=True)
        proc._mapr_control = parent
        child.close()
        await asyncio.wait_for(asyncio.get_running_loop().sock_sendall(parent, config), SUPERVISOR_START_SECONDS)
        return proc
    except BaseException:
        parent.close()
        if proc is not None:
            await asyncio.shield(_stop_supervised(proc))
        raise
    finally:
        child.close()


async def _collect_bounded(proc):
    async def drain(stream):
        output = bytearray()
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                return bytes(output)
            output.extend(chunk[:max(0, 8192 - len(output))])
    stdout, stderr = await asyncio.gather(drain(proc.stdout), drain(proc.stderr))
    await proc.wait()
    return stdout.decode('utf-8', errors='replace'), stderr.decode('utf-8', errors='replace')


def _run_supervised_sync(command, prompt, timeout):
    """Legacy synchronous API uses the same watchdog; never print raw stderr."""
    async def run():
        proc = await _spawn_supervised(command, prompt, timeout)
        try:
            stdout, stderr = await asyncio.wait_for(_collect_bounded(proc), timeout + SUPERVISOR_START_SECONDS + TERM_GRACE_SECONDS + 2)
            return subprocess.CompletedProcess(command, proc.returncode, stdout, stderr)
        finally:
            await asyncio.shield(_stop_supervised(proc))
    # This API is deliberately synchronous, intended for callers outside an
    # active event loop. The async runtime always calls _call_local_ai_async.
    return asyncio.run(run())


def _group_signal(pgid, sig):
    # Called only by the owning supervisor before reaping its child anchor,
    # or by the anchor itself with getpid()==getpgrp(). Never from a PID file.
    if pgid <= 1:
        raise RuntimeError("Invalid owned process group")
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        pass


def _anchor(control_fd, status_fd, start_fd, config):
    """A live session leader reserves the PGID through CLI exit and cleanup."""
    os.setsid()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    stopped = [False]
    def stop(*_):
        stopped[0] = True
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGHUP, stop)
    os.write(status_fd, b"R\n")
    # CLI cannot start until supervisor knows this group's exact identity.
    if os.read(start_fd, 1) != b"S":
        os._exit(125)
    os.close(start_fd)
    if select.select([control_fd], [], [], 0)[0] or stopped[0]:
        os._exit(125)
    cli = os.fork()
    if cli == 0:
        try:
            os.close(control_fd)
            os.close(status_fd)
            for name in ("SIGTERM", "SIGINT", "SIGHUP", "SIGPIPE", "SIGXFZ", "SIGXFSZ"):
                sig = getattr(signal, name, None)
                if sig is not None:
                    signal.signal(sig, signal.SIG_DFL)
            command = config["command"]
            os.execvp(command[0], command)
        except BaseException:
            # Do not print argv, prompt, environment, exceptions or credentials.
            os._exit(127)
    deadline = time.monotonic() + config["timeout"]
    finished = False
    while not stopped[0] and time.monotonic() < deadline:
        if select.select([control_fd], [], [], .05)[0]:
            break  # Supervisor exited/closed its only writer.
        if not finished:
            pid, status = os.waitpid(cli, os.WNOHANG)
            if pid:
                finished = True
                os.write(status_fd, ("E:%d\n" % os.waitstatus_to_exitcode(status)).encode())
                # Supervisor normally cleans immediately. Still bound lifetime
                # if it remains alive but becomes stuck after CLI completion.
                deadline = min(deadline, time.monotonic() + SUPERVISOR_START_SECONDS)
    # Independent fallback for supervisor SIGKILL or timeout. Keep this anchor
    # alive (TERM ignored), then kill only its own still-owned session group.
    _group_signal(os.getpid(), signal.SIGTERM)
    grace = time.monotonic() + TERM_GRACE_SECONDS
    while time.monotonic() < grace:
        if not finished:
            pid, _ = os.waitpid(cli, os.WNOHANG)
            finished = bool(pid)
        time.sleep(.05)
    _group_signal(os.getpid(), signal.SIGKILL)
    os._exit(125)


def _supervisor(fd):
    """No dependencies, network, daemonization or privileged operations."""
    control = socket.socket(fileno=fd)
    control.set_inheritable(False)
    control.settimeout(SUPERVISOR_START_SECONDS)
    config_bytes = bytearray()
    while b"\n" not in config_bytes:
        chunk = control.recv(4096)
        if not chunk:
            return 125  # Parent died before handing over configuration.
        config_bytes.extend(chunk)
        if len(config_bytes) > CONFIG_LIMIT:
            return 125
    config = json.loads(config_bytes.split(b"\n", 1)[0])
    timeout = float(config["timeout"])
    if not math.isfinite(timeout) or not 0 < timeout <= 86400:
        return 125
    if not config["command"] or not all(isinstance(arg, str) and "\0" not in arg for arg in config["command"]):
        return 125
    config["timeout"] = timeout
    control.setblocking(False)
    status_r, status_w = os.pipe()
    lifetime_r, lifetime_w = os.pipe()
    start_r, start_w = os.pipe()
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    anchor = os.fork()
    if anchor == 0:
        try:
            control.close()
            os.close(status_r); os.close(lifetime_w); os.close(start_w)
            _anchor(lifetime_r, status_w, start_r, config)
        except BaseException:
            if os.getpgrp() == os.getpid():
                _group_signal(os.getpid(), signal.SIGKILL)
            os._exit(126)
    os.close(status_w); os.close(lifetime_r); os.close(start_r)
    stopped = [False]
    def stop(*_):
        stopped[0] = True
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    ready = False
    started = False
    result = 125
    deadline = time.monotonic() + SUPERVISOR_START_SECONDS
    pending = b""
    try:
        while not stopped[0] and time.monotonic() < deadline:
            readable = select.select([control, status_r], [], [], .05)[0]
            # EOF/cancel takes priority over any ready/completed notification.
            if control in readable:
                break
            if status_r in readable:
                chunk = os.read(status_r, 4096)
                if not chunk:
                    break
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if line == b"R":
                        if os.getpgid(anchor) != anchor:
                            raise RuntimeError("Invalid owned group")
                        ready = True
                        os.write(start_w, b"S")
                        started = True
                        deadline = time.monotonic() + timeout
                    elif line.startswith(b"E:"):
                        code = int(line[2:])
                        result = code if code >= 0 else 128 - code
                        stopped[0] = True
            if started and time.monotonic() >= deadline:
                result = 124
        if started and not stopped[0] and time.monotonic() >= deadline:
            result = 124
    finally:
        os.close(start_w)
        os.close(lifetime_w)  # Also asks the anchor to perform fallback cleanup.
        if ready:
            _group_signal(anchor, signal.SIGTERM)
            # Normal CLI exit gets a short descendant cleanup window; failures
            # and cancellation get the full TERM grace.
            time.sleep(.1 if stopped[0] and result == 0 else TERM_GRACE_SECONDS)
            _group_signal(anchor, signal.SIGKILL)
        else:
            # No CLI can have started without the ready/start handshake. The
            # unreaped direct child PID cannot have been reused by the OS.
            try:
                os.kill(anchor, signal.SIGKILL)
            except ProcessLookupError:
                pass
        os.waitpid(anchor, 0)  # No group signals are allowed after this wait.
        os.close(status_r)
        control.close()
    return result


if __name__ == "__main__":
    try:
        code = _supervisor(int(sys.argv[2])) if len(sys.argv) == 3 and sys.argv[1] == "--mapr-supervisor" else 125
    except BaseException:
        code = 126
    sys.exit(code)
