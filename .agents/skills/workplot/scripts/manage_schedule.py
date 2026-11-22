"""Manage one exported workflow's local schedule from Codex."""
import http.client
import json
from pathlib import Path
import re
import sys

from open_dashboard import start

ORIGIN = "http://127.0.0.1:4310"
ACTIONS = {"show", "create", "update", "pause", "resume", "delete"}


def apply_schedule(request, action, version):
    panel = request("GET", "/schedule")
    saved = panel["schedule"]
    if action == "show":
        return panel
    if action == "create" and saved:
        raise ValueError("이미 예약이 있습니다. 변경 요청이면 update를 사용하세요.")
    if action != "create" and not saved:
        raise ValueError("등록된 예약이 없습니다.")

    body = {"expected": saved["revision"] if saved else None}
    if action == "delete":
        return request("DELETE", "/schedule", body)
    config = dict(saved["config"]) if saved else {"version": version, "enabled": True}
    if action in {"pause", "resume"}:
        config["enabled"] = action == "resume"
    else:
        raw = sys.stdin.read(40001)
        if len(raw) > 40000:
            raise ValueError("예약 입력이 너무 깁니다.")
        updates = json.loads(raw)
        if not isinstance(updates, dict) or set(updates) - {"weekday", "time", "material"}:
            raise ValueError("예약 입력 항목을 확인하세요.")
        config.update(updates)
    return request("PUT", "/schedule", {**body, "config": config})


def manage(action, name):
    if action not in ACTIONS or len(name) > 64 or not re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", name):
        raise ValueError("동작과 등록된 워크플롯 스킬 이름을 확인하세요.")
    manifest = Path.home() / ".agents" / "skills" / name / "SKILL.md"
    marker = re.search(r"^<!-- workplot-export ([a-f0-9-]{36}) ([1-9]\d*) -->$", manifest.read_text(), re.M)
    if not marker:
        raise ValueError("Workplot 보관함에서 등록한 스킬을 선택하세요.")
    workflow, version = marker[1], int(marker[2])
    start()
    conn = http.client.HTTPConnection("127.0.0.1", 4310, timeout=15)
    try:
        conn.request("POST", "/api/session", headers={"Origin": ORIGIN, "X-Studio-Client": "browser"})
        response = conn.getresponse()
        response.read()
        if response.status != 204:
            raise ValueError("Workplot 세션을 열 수 없습니다.")
        headers = {
            "Cookie": response.getheader("Set-Cookie").split(";")[0],
            "Origin": ORIGIN,
            "Content-Type": "application/json",
        }

        def request(method, path, body=None):
            payload = json.dumps(body) if body is not None else None
            conn.request(method, "/api/workflows/" + workflow + path, body=payload, headers=headers)
            response = conn.getresponse()
            data = json.loads(response.read())
            if response.status >= 400:
                raise ValueError("Workplot 예약 요청 실패 · " + str(data.get("error", response.status)))
            return data

        if {"name": name, "version": version} not in request("GET", "/codex-skills"):
            raise ValueError("등록 버전을 확인할 수 없습니다.")
        panel = apply_schedule(request, action, version)
        record = panel["schedule"]
        if record and record["config"]["material"]["kind"] == "text":
            record["config"]["material"] = {"kind": "text"}
        print(json.dumps({
            "skill": name, "schedule": record, "timezone": "Asia/Seoul",
            "folder": panel["folder"], "link": ORIGIN + "/#/library",
        }, ensure_ascii=False))
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("manage_schedule.py <동작> <스킬 이름>")
        manage(*sys.argv[1:])
    except (OSError, ValueError, RuntimeError, http.client.HTTPException) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
