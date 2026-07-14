"""
risk-sandbox — executes agent-authored Python against tenant data and returns a
deterministic verdict.

Why this service exists: the risk engine's LangGraph agent proposes hypotheses
and writes the Python that tests them. Without somewhere safe to *run* that
Python, the engine used to fall back to asking the LLM to state the severity and
the affected/total counts itself — numbers that look exactly like measurements
and are not. This service is what makes that fallback unnecessary; the CRM now
reports `inconclusive` rather than inventing a verdict when it is unreachable.

Contract (unchanged from src/lib/ai/langgraph/risk-sandbox-client.ts):

    GET  /healthz  -> {"ok": true}
    POST /execute  <- {"hypothesis_slug", "code", "data": {loans, vehicle_states, daily_km}}
                   -> {"ok": true,  "result": {severity, affected_count, total_count,
                                               finding_summary, evidence}, "elapsed_ms"}
                   -> {"ok": false, "error": "...", "elapsed_ms"}

Security posture:
  • Bearer token required. The service refuses to start without SANDBOX_TOKEN
    unless SANDBOX_ALLOW_NO_AUTH=1 is set explicitly (local dev only). The old
    deployment had no auth at all: anything that could reach the port received
    the tenant's full loan + telemetry payload.
  • Static AST gate (validator.py) before anything is executed.
  • Execution in a short-lived child process with CPU / memory / fork caps,
    hard-killed at 30s. The API process itself never exec()s the code.
  • No database connection and no outbound network. The caller ships the data
    with the code, so there are no credentials here to steal.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from validator import ValidationError, validate

WORKER = Path(__file__).parent / "worker.py"

# Wall-clock cap. The client (risk-sandbox-client.ts) waits 35s, and worker.py
# caps CPU at 25s, so the ordering is: CPU limit → our kill → client timeout.
# Each layer fires before the one outside it, so a hang is always attributed to
# the innermost cause rather than surfacing as an opaque client-side abort.
EXEC_TIMEOUT_S = 30

SANDBOX_TOKEN = os.environ.get("SANDBOX_TOKEN", "").strip()
ALLOW_NO_AUTH = os.environ.get("SANDBOX_ALLOW_NO_AUTH") == "1"

if not SANDBOX_TOKEN and not ALLOW_NO_AUTH:
    raise RuntimeError(
        "SANDBOX_TOKEN is not set. This service receives borrower loan and telemetry "
        "data; it must not listen without authentication. Set SANDBOX_TOKEN (and the "
        "matching NBFC_SANDBOX_TOKEN in the CRM), or set SANDBOX_ALLOW_NO_AUTH=1 for "
        "local development only."
    )

app = FastAPI(title="risk-sandbox", docs_url=None, redoc_url=None, openapi_url=None)


class ExecuteRequest(BaseModel):
    hypothesis_slug: str = Field(min_length=1, max_length=128)
    code: str = Field(min_length=1, max_length=20_000)
    data: dict[str, list] = Field(default_factory=dict)


def _check_auth(authorization: str | None) -> None:
    if not SANDBOX_TOKEN:
        return  # dev mode, explicitly opted into via SANDBOX_ALLOW_NO_AUTH
    expected = f"Bearer {SANDBOX_TOKEN}"
    # Constant-time compare so a wrong token can't be recovered by timing.
    if not authorization or not _const_eq(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


def _const_eq(a: str, b: str) -> bool:
    import hmac

    return hmac.compare_digest(a.encode(), b.encode())


def _worker_env() -> dict[str, str]:
    """
    The minimum environment the interpreter needs to boot, and nothing more.
    Notably absent: SANDBOX_TOKEN, and anything else in the API process's env.
    On Windows, CPython needs SystemRoot to initialise; on Linux this is just PATH.
    """
    env = {"PATH": os.environ.get("PATH", ""), "PYTHONHASHSEED": "0"}
    for passthrough in ("SystemRoot", "COMSPEC"):  # Windows dev boxes only
        if passthrough in os.environ:
            env[passthrough] = os.environ[passthrough]
    return env


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "auth": bool(SANDBOX_TOKEN)}


@app.post("/execute")
def execute(req: ExecuteRequest, authorization: str | None = Header(default=None)) -> dict:
    _check_auth(authorization)
    started = time.monotonic()

    def elapsed_ms() -> int:
        return int((time.monotonic() - started) * 1000)

    # 1. Refuse code that has no business running, before we run any of it.
    try:
        validate(req.code)
    except ValidationError as e:
        return {"ok": False, "error": f"rejected by static validator: {e}", "elapsed_ms": elapsed_ms()}

    # 2. Execute in a child process we can kill.
    job = json.dumps({"code": req.code, "data": req.data})
    try:
        proc = subprocess.run(
            [sys.executable, str(WORKER)],
            input=job,
            capture_output=True,
            text=True,
            timeout=EXEC_TIMEOUT_S,
            # No inherited environment: the worker gets nothing it could exfiltrate.
            # (SANDBOX_TOKEN in particular must never be visible to the code we run.)
            env=_worker_env(),
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "error": f"hypothesis exceeded the {EXEC_TIMEOUT_S}s execution cap and was killed",
            "elapsed_ms": elapsed_ms(),
        }

    if proc.returncode != 0:
        # The worker traps its own exceptions, so a non-zero exit means it was
        # killed from outside — OOM, or a resource limit it could not catch.
        detail = (proc.stderr or "").strip()[-300:] or f"worker exited {proc.returncode}"
        return {"ok": False, "error": f"worker died: {detail}", "elapsed_ms": elapsed_ms()}

    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": "worker returned no parseable verdict", "elapsed_ms": elapsed_ms()}

    payload["elapsed_ms"] = elapsed_ms()
    return payload
