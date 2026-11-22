"""Start the local Workplot dashboard or reuse the healthy instance on port 4310."""
import fcntl
import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[4]
DATA = ROOT / ".local"
URL = "http://127.0.0.1:4310/"


def ready():
    conn = http.client.HTTPConnection("127.0.0.1", 4310, timeout=3)
    try:
        conn.request("GET", "/api/health")
        health = conn.getresponse()
        if health.status == 200:
            result = json.loads(health.read(4096))
            if isinstance(result, dict) and result.get("status") == "ok" and result.get("database") == "ready":
                conn.close()
                conn.request("GET", "/")
                home = conn.getresponse()
                if home.status == 200 and b"<title>Workplot</title>" in home.read(16384):
                    return True
        raise RuntimeError("4310번 포트가 열려 있지만 Workplot 대시보드를 확인할 수 없습니다.")
    except ConnectionRefusedError:
        return False
    except PermissionError as error:
        raise RuntimeError("로컬 서버 접근 권한이 필요합니다. 같은 실행 명령에 권한을 요청하세요.") from error
    finally:
        conn.close()


def start():
    if ready():
        return "실행 중"
    DATA.mkdir(mode=0o700, exist_ok=True)
    with (DATA / "dashboard-start.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if ready():
            return "실행 중"
        pinned = (ROOT / ".nvmrc").read_text().strip()
        nvm_dir = Path(os.environ.get("NVM_DIR", Path.home() / ".nvm"))
        node = nvm_dir / "versions" / "node" / ("v" + pinned) / "bin" / "node"
        if not node.is_file():
            found = shutil.which("node")
            if not found or subprocess.check_output([found, "--version"], text=True).strip() != "v" + pinned:
                raise RuntimeError("Workplot에 필요한 Node " + pinned + "을 찾을 수 없습니다.")
            node = Path(found)
        env = {**os.environ, "PATH": str(node.parent) + os.pathsep + os.environ.get("PATH", "")}
        server = ROOT / "apps/server/dist/index.js"
        if not server.is_file() or not (ROOT / "apps/web/dist/index.html").is_file():
            if not (ROOT / "node_modules").is_dir():
                raise RuntimeError("프로젝트 의존성이 없습니다. Workplot 폴더에서 npm ci가 필요합니다.")
            subprocess.run(["npm", "run", "build"], cwd=ROOT, env=env, check=True)
        log = DATA / "dashboard-server.log"
        with log.open("ab") as output:
            child = subprocess.Popen(
                [str(node), str(server)], cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                stdout=output, stderr=subprocess.STDOUT, start_new_session=True,
            )
        for _ in range(80):
            if ready():
                return "시작 완료"
            if child.poll() is not None:
                break
            time.sleep(0.15)
        raise RuntimeError(f"서버 시작을 확인할 수 없습니다. 로그: {log}")


if __name__ == "__main__":
    try:
        print(f"Workplot {start()} · {URL}")
    except (OSError, RuntimeError, ValueError, http.client.HTTPException, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
