#!/usr/bin/env bash
set -euo pipefail

run=${1:?Usage: drive-auth.sh RUN}
scripts=.cursor/skills/verify-parlor/scripts
export PARLOR_RUN="$run"
"$scripts/stack.py" browser "$run" <<'PY' | tee "$run/evidence/01-auth-trace.jsonl"
import base64
import json
import os
from pathlib import Path
import secrets
import time

web = os.environ["PARLOR_WEB_URL"]
proof = Path(os.environ["PARLOR_RUN"]) / "evidence"
username = "parlor_verify"
display_name = "Parlor Verify"
password = secrets.token_urlsafe(20)


def wait(check, description):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.2)
    raise RuntimeError(f"Missing {description} at {js('location.pathname')}")


def ax():
    return cdp("Accessibility.getFullAXTree")["nodes"]


def node(role, name):
    return next((item for item in ax() if item.get("backendDOMNodeId")
                 and item["role"]["value"] == role and item.get("name", {}).get("value") == name), None)


def click(role, name):
    element = wait(lambda: node(role, name), f"{role} {name}")
    dom_id = element["backendDOMNodeId"]
    cdp("DOM.scrollIntoViewIfNeeded", backendNodeId=dom_id)
    quad = cdp("DOM.getBoxModel", backendNodeId=dom_id)["model"]["content"]
    click_at_xy(sum(quad[::2]) / 4, sum(quad[1::2]) / 4)


def fill(element_id, value):
    selector = json.dumps(f"#{element_id}")
    wait(lambda: js(f"Boolean(document.querySelector({selector}))"), element_id)
    js(f"document.querySelector({selector}).focus()")
    press_key("a", modifiers=2)
    cdp("Input.insertText", text=value)


def at(path):
    wait(lambda: js("location.pathname + location.search") == path, path)


def response(path, status):
    entry = wait(lambda: js(f"""performance.getEntriesByName({json.dumps(web + path)})
        .filter(e => e.responseStatus === {status}).length"""), f"{path} HTTP {status}")
    assert entry


def capture(step, action, result, http=None):
    roles = {"heading", "link", "button", "DisclosureTriangle", "alert", "textbox"}
    names = [{"role": item["role"]["value"], "name": item.get("name", {}).get("value", "")}
             for item in ax() if item["role"]["value"] in roles and not item["ignored"]]
    (proof / f"01-{step}.aria.json").write_text(json.dumps(names, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"feature": "01", "step": step, "action": action,
                      "path": js("location.pathname + location.search"),
                      "result": result, **({"http": http} if http else {})},
                     ensure_ascii=False), flush=True)


tab = new_tab(web)
try:
    for area in ("nav[aria-label='主导航']", "header", ".lp-final"):
        wait_for_load()
        selector = json.dumps(f"{area} a[href='/login?next=%2Fhome']")
        wait(lambda: js(f"Boolean(document.querySelector({selector}))"), f"{area} 进入房间")
        if area.startswith("nav"):
            capture("landing", "Open /", "Parlor landing and entry links rendered")
        # Scope duplicate accessible names to the navigation, hero or closing CTA.
        js(f"document.querySelector({selector}).focus()")
        press_key("Enter")
        at("/login?next=%2Fhome")
        wait(lambda: node("heading", "登录 Parlor"), "login heading")
        print(json.dumps({"feature": "01", "action": f"Activate 进入房间 in {area}",
                          "result": "/login?next=%2Fhome"}, ensure_ascii=False), flush=True)
        goto_url(web)
    click("link", "登录")
    at("/login")
    print(json.dumps({"feature": "01", "action": "Activate 登录 in main navigation",
                      "result": "/login"}, ensure_ascii=False), flush=True)
    goto_url(f"{web}/login?mode=register")
    wait(lambda: node("heading", "创建账户"), "direct registration heading")
    print(json.dumps({"feature": "01", "action": "Open /login?mode=register",
                      "result": "Registration form rendered"}, ensure_ascii=False), flush=True)
    goto_url(f"{web}/home")
    at("/login?next=%2Fhome")
    wait(lambda: node("heading", "登录 Parlor"), "login heading")
    capture("gate", "Open /home while signed out", "Login preserves the requested return path")

    click("button", "注册账号")
    fill("auth-username", username)
    fill("auth-user-display-name", display_name)
    fill("auth-user-password", password)
    click("button", "创建账户并继续")
    at("/home")
    wait(lambda: node("heading", "房间"), "rooms heading after registration")
    response("/api/v1/auth/register", 200)
    response("/api/v1/rooms", 200)
    capture("registered", "Submit username registration", "Signed in and viewing rooms",
            {"POST /api/v1/auth/register": 200, "GET /api/v1/rooms": 200})

    wait(lambda: js("Boolean(document.querySelector('summary[title=\"Parlor Verify\"]'))"), "account menu")
    js("document.querySelector('summary[title=\"Parlor Verify\"]').focus()")
    press_key("Enter")
    click("button", "退出登录")
    at("/login?next=%2Fhome")
    wait(lambda: node("heading", "登录 Parlor"), "login heading after logout")
    capture("logout", "Select account menu > 退出登录", "Protected page returned to login")

    fill("auth-identifier", username)
    fill("auth-password", "Incorrect-" + password)
    click("button", "登录")
    wait(lambda: node("alert", "") and js(
         "document.querySelector('[role=alert]')?.textContent.includes('账号或密码错误，请重试')"),
         "wrong password alert")
    response("/api/v1/auth/login", 401)
    capture("rejected", "Submit an incorrect password", "Login page shows authentication error",
            {"POST /api/v1/auth/login": 401})

    fill("auth-password", password)
    click("button", "登录")
    at("/home")
    wait(lambda: node("heading", "房间"), "rooms heading after login")
    response("/api/v1/auth/login", 200)
    capture("login", "Submit the registered password", "Returned to rooms",
            {"POST /api/v1/auth/login": 200})
    goto_url(f"{web}/home")
    wait_for_load()
    at("/home")
    wait(lambda: node("heading", "房间"), "rooms heading after reload")
    response("/api/v1/rooms", 200)
    capture("reload", "Reload the rooms page", "Session survives reload and rooms still load",
            {"GET /api/v1/rooms": 200})
    try:
        shot = cdp("Page.captureScreenshot", format="png", _response_timeout=5)
        (proof / "01-rooms.png").write_bytes(base64.b64decode(shot["data"]))
    except (RuntimeError, TimeoutError) as error:
        print(json.dumps({"feature": "01", "screenshot": "unavailable", "reason": str(error)}), flush=True)
finally:
    close_tab(tab)
PY

pg_bin=${PARLOR_PG_BIN:-$(pg_config --bindir)}
"$pg_bin/psql" -X -At -v ON_ERROR_STOP=1 -h "$run/runtime" -p 5432 -U parlor -d postgres \
  -c "SELECT username, user_type, (last_seen_at IS NOT NULL) FROM users WHERE username = 'parlor_verify';" \
  | tee "$run/evidence/01-auth-db.txt"
test "$(cat "$run/evidence/01-auth-db.txt")" = 'parlor_verify|human|t'
