#!/usr/bin/env python3
"""Run a disposable Parlor Hub, frontend and browser on Linux."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener

LOOPBACK = "127.0.0.1"
HTTP = build_opener(ProxyHandler({}))
REPO = Path.cwd()


def fetch(url):
    with HTTP.open(url, timeout=2) as response:
        return response.read()


def free_ports():
    with socket.socket() as hub, socket.socket() as web, socket.socket() as browser:
        for listener in (hub, web, browser):
            listener.bind((LOOPBACK, 0))
        return dict(zip(("hub", "web", "browser"), (s.getsockname()[1] for s in (hub, web, browser))))


def process_start(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return fields[19] if fields[0] != "Z" else None
    except FileNotFoundError:
        return None


def alive(process):
    return process_start(process["pid"]) == process["start"] and process["start"] is not None


def wait_for(check, timeout=60):
    deadline = time.monotonic() + timeout
    while True:
        try:
            return check()
        except (OSError, ValueError, RuntimeError) as error:
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Timed out: {error}") from error
            time.sleep(0.25)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def browser_env(run, state):
    return {
        **os.environ,
        "BU_NAME": "parlor-verification",
        "BU_CDP_URL": f"http://{LOOPBACK}:{state['ports']['browser']}",
        "BU_CDP_WS": "",
        "BH_RUNTIME_DIR": str(run / "runtime/harness"),
        "BH_TMP_DIR": str(run / "evidence/harness"),
        "BH_RUNTIME_DIR_SHARED": "0",
        "BH_TMP_DIR_SHARED": "0",
        "BH_TAB_MARKER": "0",
        "BH_RECORD": "0",
    }


def inspect(state):
    for name, process in state["processes"].items():
        require(alive(process), f"{name} process stopped")
    listeners = subprocess.check_output(["ss", "-Hltnp"], text=True).splitlines()
    for name, port in state["ports"].items():
        owned_pid = state["processes"][name]["pid"]
        require(any(line.split()[3] == f"{LOOPBACK}:{port}" and f"pid={owned_pid}," in line
                    for line in listeners), f"{name} does not own {LOOPBACK}:{port}")
    hub, web = state["hub_url"], state["web_url"]
    readiness = json.loads(fetch(f"{hub}/ready"))
    require(readiness["status"] == "ready" and readiness["service"] == "Parlor", "Hub is not ready")
    require(b"<title>Parlor" in fetch(web), "Frontend is not Parlor")
    templates = json.loads(fetch(f"{web}/api/v1/templates"))["templates"]
    require(templates, "Built-in room templates have not been seeded")
    providers = json.loads(fetch(f"{web}/api/v1/auth/providers"))
    require(not providers["email_enabled"] and not providers["google_enabled"], "Unexpected external auth provider")
    try:
        fetch(f"{web}/api/v1/auth/me")
    except HTTPError as error:
        require(error.code == 401, f"Expected HTTP 401 for anonymous auth/me, got {error.code}")
    else:
        raise RuntimeError("auth/me accepted an anonymous request")
    return {**state, "readiness": readiness, "system_templates": len(templates),
            "providers": providers, "anonymous_auth_status": 401}


def cleaned(state):
    require(all(not alive(proc) for proc in state["processes"].values()), "A run process remains alive")
    for name, port in state["ports"].items():
        with socket.socket() as client:
            client.settimeout(1)
            require(client.connect_ex((LOOPBACK, port)) != 0, f"{name} port {port} still accepts connections")


def stop_harness(run, state):
    env = browser_env(run, state)
    pid_file = Path(env["BH_RUNTIME_DIR"]) / "bu.pid"
    if not pid_file.exists():
        return
    pid = int(pid_file.read_text().strip())
    start = process_start(pid)
    try:
        marker = os.fsencode(f"BH_RUNTIME_DIR={env['BH_RUNTIME_DIR']}")
        owned = marker in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    except FileNotFoundError:
        return
    if owned and alive({"pid": pid, "start": start}):
        os.kill(pid, signal.SIGTERM)
        wait_for(lambda: require(process_start(pid) != start, "browser-harness daemon did not stop"), timeout=5)


def launch(run):
    require((REPO / "frontend/node_modules/vite").is_dir(), "Run npm ci in frontend first")
    require(shutil.which("browser-harness"), "Install browser-harness first")
    require(not (run / "instance.json").exists(), "Use a fresh mktemp directory for each launch")
    runtime = run / "runtime"
    runtime.mkdir(mode=0o700)
    evidence = run / "evidence"
    evidence.mkdir(mode=0o700)
    children = {}
    ports = free_ports()
    state = {
        "repo": str(REPO),
        "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "hub_url": f"http://{LOOPBACK}:{ports['hub']}",
        "web_url": f"http://{LOOPBACK}:{ports['web']}",
        "ports": ports,
        "supervisor": {"pid": os.getpid(), "start": process_start(os.getpid())},
        "processes": {},
    }
    # Pass only launch settings. Run Hub and Alembic outside the checkout to avoid loading its .env.
    env = {key: os.environ[key] for key in ("PATH", "LANG") if key in os.environ}
    env.update(
        PYTHONPATH=str(REPO / "backend"),
        PYTHONDONTWRITEBYTECODE="1",
        MAPR_ENVIRONMENT="development",
        MAPR_DATABASE_URL=f"postgresql+asyncpg://parlor@/postgres?host={runtime}",
        MAPR_REDIS_URL=f"unix://{runtime / 'redis.sock'}",
        MAPR_AUTH_SECRET_KEY=secrets.token_hex(32),
        MAPR_REPOSITORY_ROOT=str(runtime / "repos"),
        MAPR_A2A_PUBLIC_URL=state["hub_url"],
    )

    def start(name, args, cwd=runtime):
        with (evidence / f"{name}.log").open("w") as log:
            child = subprocess.Popen(args, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True)
        children[name] = child
        state["processes"][name] = {"pid": child.pid, "start": process_start(child.pid)}

    def run_command(log_name, args):
        with (evidence / f"{log_name}.log").open("w") as log:
            subprocess.run(args, cwd=runtime, env=env, stdout=log, stderr=subprocess.STDOUT,
                           timeout=90, check=True)

    def interrupt(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    try:
        pg = Path(os.environ.get("PARLOR_PG_BIN") or subprocess.check_output(
            ["pg_config", "--bindir"], text=True).strip())
        db = runtime / "postgres"
        run_command("initdb", [pg / "initdb", "-D", db, "-U", "parlor", "--auth=trust", "--no-locale", "-E", "UTF8"])
        start("postgres", [pg / "postgres", "-D", db, "-h", "", "-k", runtime])
        start("redis", ["redis-server", "--port", "0", "--unixsocket", runtime / "redis.sock",
                        "--unixsocketperm", "700", "--save", "", "--appendonly", "no"])
        wait_for(lambda: require(subprocess.run([pg / "pg_isready", "-h", runtime, "-U", "parlor", "-d", "postgres", "-q"]).returncode == 0,
                                 "PostgreSQL is starting"))
        run_command("alembic", [sys.executable, "-m", "alembic", "-c", REPO / "alembic.ini", "upgrade", "head"])
        start("hub", [sys.executable, "-m", "uvicorn", "app.main:app",
                      "--host", LOOPBACK, "--port", str(ports["hub"])])
        vite = """
import { createServer } from 'vite'
const [hub, port, cacheDir] = process.argv.slice(1)
const proxy = Object.fromEntries(['/api', '/a2a', '/.well-known', '/ws']
  .map(prefix => [prefix, { target: hub, ws: prefix === '/ws' }]))
const server = await createServer({ envFile: false, cacheDir,
  server: { host: '127.0.0.1', port: Number(port), strictPort: true, proxy } })
await server.listen()
"""
        start("web", ["node", "--input-type=module", "-e", vite, state["hub_url"],
                      str(ports["web"]), runtime / "vite"], cwd=REPO / "frontend")
        chrome = os.environ.get("PARLOR_CHROMIUM", "chromium")
        start("browser", [chrome, "--headless", "--disable-background-networking", "--no-proxy-server",
                          "--disable-breakpad", "--disable-crash-reporter", "--window-size=1440,1000",
                          "--disable-component-update", "--no-first-run", "--no-default-browser-check",
                          f"--user-data-dir={runtime / 'chrome'}",
                          f"--remote-debugging-port={ports['browser']}", "about:blank"])
        wait_for(lambda: fetch(f"http://{LOOPBACK}:{ports['browser']}/json/version"))
        wait_for(lambda: inspect(state))
        (run / "instance.json").write_text(json.dumps(state, indent=2) + "\n")
        print(f"Parlor ready at {state['web_url']} (run {run})", flush=True)
        while all(child.poll() is None for child in children.values()):
            time.sleep(0.5)
        raise RuntimeError("A Parlor process exited; see the run's evidence logs")
    except KeyboardInterrupt:
        pass
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        for child in reversed(list(children.values())):
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
        stop_harness(run, state)
        cleaned(state)
        shutil.rmtree(runtime)
        (evidence / "cleanup.json").write_text(json.dumps(
            {"stopped": state["processes"], "released_ports": ports, "removed_runtime": str(runtime)}, indent=2
        ) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("launch", "doctor", "browser", "cleanup"))
    parser.add_argument("run", type=Path)
    args = parser.parse_args()
    run = args.run.resolve(strict=True)
    if args.action == "launch":
        launch(run)
        return
    state = json.loads((run / "instance.json").read_text())
    if args.action in ("doctor", "browser"):
        require(str(REPO) == state["repo"], "Run doctor from the launch checkout")
        revision = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        require(revision == state["revision"], "Checkout revision changed since launch")
        details = inspect(state)
        if args.action == "doctor":
            print(json.dumps(details, indent=2))
        else:
            env = {**browser_env(run, state), "PARLOR_RUN": str(run), "PARLOR_WEB_URL": state["web_url"]}
            subprocess.run(["browser-harness"], env=env, check=True)
        return
    supervisor = state["supervisor"]
    if alive(supervisor):
        os.kill(supervisor["pid"], signal.SIGTERM)
    wait_for(lambda: require((run / "evidence/cleanup.json").is_file(), "Awaiting cleanup evidence"))
    cleaned(state)
    require(not (run / "runtime").exists(), "Scratch state remains after cleanup")
    print(f"Cleaned {run}; evidence retained at {run / 'evidence'}")


if __name__ == "__main__":
    main()
