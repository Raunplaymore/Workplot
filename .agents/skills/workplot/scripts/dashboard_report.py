"""Collect a read-only Workplot dashboard snapshot for a chat report."""
from datetime import datetime
from http.client import HTTPConnection, HTTPException
import json
import re
import sys
from urllib.parse import quote
from zoneinfo import ZoneInfo

ORIGIN = "http://127.0.0.1:4310"
SEOUL = ZoneInfo("Asia/Seoul")


def excerpt(text):
    lines = [s.strip() for s in text.splitlines() if s.strip()]
    line = next((s for s in lines if re.match(r"추천 과제\s*[·:]", s)), None)
    if not line:
        line = next((s for s in lines if not s.startswith(("#", "|", "```", "---"))), "")
    line = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", line).replace("*", "").replace("`", "")
    return line if len(line) <= 260 else line[:259] + "…"


def collect(get):
    rows = get("/runs")
    by_id = {row["id"]: row for row in rows}
    active = [r for r in rows if r.get("occupiesSlot") or r.get("quotaRetryAt") or r["status"] in ("waiting", "running", "queued")]
    report = {"as_of": datetime.now(SEOUL).isoformat(timespec="seconds"), "runs": []}
    for row in active:
        rid = row["id"]
        history = []
        seen = {rid}
        parent = row.get("previousSessionId")
        while parent in by_id and parent not in seen:
            seen.add(parent)
            previous = by_id[parent]
            history.append(previous)
            parent = previous.get("previousSessionId")
        item = {"workflow": row["name"], "version": row["workflowVersion"], "round": len(history)+1,
                "status": row["status"], "url": ORIGIN + "/#/runs/" + rid,
                "recent": [{"status": h["status"], "summary": h.get("sessionSummary"), "url": ORIGIN+"/#/runs/"+h["id"]} for h in history[:3]]}
        report["runs"].append(item)
        base = "/runs/" + rid
        try:
            v = get(base+"/view")
            workflow = get("/workflows/"+row["workflowId"]+"/versions/"+str(row["workflowVersion"])+"?expanded=1")
            titles = {s["id"]: s["title"] for s in workflow["definition"]["steps"]}
            item.update(status=v["summary"]["status"], stage=titles.get(v["stepId"], v["stepId"]),
                        gate=(v.get("gate") or {}).get("kind"), quotaRetryAt=v.get("quotaRetryAt") or row.get("quotaRetryAt"),
                        request=v["summary"].get("taskRequest","")[:260], documents=[])
            for file in v["results"]:
                text = get(base+"/results/"+quote(file,safe=""), plain=True)
                item["documents"].append({"file": file, "stage": titles.get(file.removesuffix(".md")), "excerpt": excerpt(text)})
            d = get(base+"/delegation")
            item["delivery"] = get(base+"/delivery")
            if d.get("config"):
                cfg = d["config"]
                item["delegation"] = {"enabled": d["enabled"], "used": d["used"], "limit": cfg["maxSessions"],
                                      "until": datetime.fromisoformat(cfg["until"].replace("Z","+00:00")).astimezone(SEOUL).isoformat(timespec="minutes"),
                                      "note": d["note"]}
        except (ValueError, OSError, HTTPException) as err:
            item["partial_error"] = str(err)
    closed = {}
    for row in sorted(rows, key=lambda r: r.get("recordedAt", ""), reverse=True):
        if row["status"] in ("completed", "failed", "stopped"):
            closed.setdefault(row["workflowId"], row)
    report["latest_closed"] = []
    for row in closed.values():
        item = {"workflow": row["name"], "status": row["status"], "summary": row.get("sessionSummary"),
                "url": ORIGIN + "/#/runs/" + row["id"]}
        report["latest_closed"].append(item)
        try:
            item["delivery"] = get("/runs/" + row["id"] + "/delivery")
        except (ValueError, OSError, HTTPException) as err:
            item["delivery_error"] = str(err)
    return report


def main():
    conn = HTTPConnection("127.0.0.1", 4310, timeout=10)
    try:
        conn.request("POST","/api/session", headers={"Origin":ORIGIN,"X-Studio-Client":"browser"})
        response = conn.getresponse()
        response.read()
        cookie = response.getheader("Set-Cookie")
        if response.status != 204 or not cookie:
            raise ValueError("Workplot 조회 세션을 열 수 없습니다.")
        def get(path, plain=False):
            conn.request("GET","/api"+path, headers={"Origin":ORIGIN,"Cookie":cookie.split(";")[0]})
            result = conn.getresponse()
            raw = result.read()
            if result.status != 200:
                raise ValueError(f"조회 실패 {result.status} · {path}")
            return raw.decode() if plain else json.loads(raw)
        print(json.dumps(collect(get), ensure_ascii=False, indent=2))
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        main()
    except (ValueError,OSError,HTTPException) as err:
        sys.exit(f"Workplot 현황 조회 실패 · {err}")
