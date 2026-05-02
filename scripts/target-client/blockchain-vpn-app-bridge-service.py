#!/usr/bin/env python3
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import time


BRIDGE_DIR = pathlib.Path(os.environ.get("BVPN_APP_BRIDGE_DIR", "/var/lib/blockchain-vpn/bridge"))
REQUEST_DIR = BRIDGE_DIR / "requests"
RESPONSE_DIR = BRIDGE_DIR / "responses"
STATUS_FILE = BRIDGE_DIR / "status.json"
RUNNER_BIN = os.environ.get("BVPN_APP_BRIDGE_RUNNER", "/usr/local/bin/blockchain-vpn-app-bridge-runner")
POLL_SECS = float(os.environ.get("BVPN_APP_BRIDGE_SERVICE_POLL_SECS", "0.5"))
STATUS_INTERVAL_SECS = float(os.environ.get("BVPN_APP_BRIDGE_STATUS_INTERVAL_SECS", "5"))
DIR_MODE = int(os.environ.get("BVPN_APP_BRIDGE_DIR_MODE", "0o1777"), 8)
FILE_MODE = int(os.environ.get("BVPN_APP_BRIDGE_FILE_MODE", "0o666"), 8)
RESPONSE_TTL_SECS = float(os.environ.get("BVPN_APP_BRIDGE_RESPONSE_TTL_SECS", "60"))


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_paths() -> None:
    for path in (BRIDGE_DIR, REQUEST_DIR, RESPONSE_DIR):
        path.mkdir(parents=True, exist_ok=True)
        os.chmod(path, DIR_MODE)


def atomic_write_json(path: pathlib.Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh)
        fh.write("\n")
    os.chmod(tmp, FILE_MODE)
    os.replace(tmp, path)
    os.chmod(path, FILE_MODE)


def run_runner(command: str, args: dict | None = None) -> tuple[int, str, str]:
    if not shutil.which(RUNNER_BIN):
        payload = json.dumps(
            {
                "ok": False,
                "command": command,
                "code": "bridge_dependency_missing",
                "message": f"runner not found: {RUNNER_BIN}",
            }
        )
        return 30, payload, ""

    argv = [RUNNER_BIN, command]
    if command == "logs":
        argv.append(str((args or {}).get("count", 100)))
    proc = subprocess.run(argv, capture_output=True, text=True)
    return proc.returncode, proc.stdout, proc.stderr


def update_status() -> None:
    rc, out, err = run_runner("status")
    payload = {
        "ok": rc == 0,
        "command": "status",
        "code": "status_refresh_failed" if rc != 0 else "status",
        "message": err.strip() or "status refreshed",
        "refreshed_at": now_iso(),
    }
    try:
      parsed = json.loads(out) if out.strip() else {}
      if isinstance(parsed, dict):
          payload = parsed
          payload["refreshed_at"] = now_iso()
    except Exception:
      payload["raw_stdout"] = out
    atomic_write_json(STATUS_FILE, payload)


def process_request(path: pathlib.Path) -> None:
    try:
        with path.open("r", encoding="utf-8") as fh:
            request = json.load(fh)
    except Exception as exc:
        bad = {
            "ok": False,
            "command": "unknown",
            "code": "bad_request",
            "message": f"failed to parse request: {exc}",
            "received_at": now_iso(),
        }
        atomic_write_json(RESPONSE_DIR / f"{path.stem}.json", bad)
        path.unlink(missing_ok=True)
        return

    request_id = request.get("request_id", path.stem)
    command = request.get("command", "status")
    args = request.get("args", {})

    rc, out, err = run_runner(command, args)
    response_path = RESPONSE_DIR / f"{request_id}.json"

    if command == "logs":
        payload = {
            "ok": rc == 0,
            "command": command,
            "code": "logs" if rc == 0 else "logs_failed",
            "message": err.strip() or "logs collected",
            "logs": out,
            "completed_at": now_iso(),
        }
    else:
        try:
            payload = json.loads(out) if out.strip() else {}
            if not isinstance(payload, dict):
                raise ValueError("runner output is not an object")
        except Exception as exc:
            payload = {
                "ok": False,
                "command": command,
                "code": "bridge_runner_parse_failed",
                "message": f"failed to parse runner output: {exc}",
                "raw_stdout": out,
                "raw_stderr": err,
                "completed_at": now_iso(),
            }
        else:
            payload["completed_at"] = now_iso()

    atomic_write_json(response_path, payload)
    path.unlink(missing_ok=True)
    update_status()


def cleanup_responses() -> None:
    cutoff = time.time() - RESPONSE_TTL_SECS
    for response in RESPONSE_DIR.glob("*.json"):
        try:
            if response.stat().st_mtime < cutoff:
                response.unlink(missing_ok=True)
        except FileNotFoundError:
            continue


def main() -> int:
    if os.geteuid() != 0:
        print("blockchain-vpn-app-bridge-service.py must run as root", file=sys.stderr)
        return 10

    ensure_paths()
    update_status()
    last_status = 0.0

    while True:
        for request in sorted(REQUEST_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime):
            process_request(request)

        if time.monotonic() - last_status >= STATUS_INTERVAL_SECS:
            update_status()
            last_status = time.monotonic()

        cleanup_responses()
        time.sleep(POLL_SECS)


if __name__ == "__main__":
    raise SystemExit(main())
