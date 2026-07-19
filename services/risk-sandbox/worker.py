"""
The process that actually runs agent-authored Python.

Run as a short-lived child of the API process, never in it. Reads one JSON job
on stdin, writes one JSON verdict on stdout, exits. If the code hangs, loops
forever, or allocates the box to death, the parent kills this process and the
API survives — which is the entire reason it is a separate process.

  stdin : {"code": "<python>", "data": {"loans": [...], "vehicle_states": [...], "daily_km": [...]}}
  stdout: {"ok": true, "result": {...}} | {"ok": false, "error": "..."}

Nothing here talks to a database. The caller ships the data with the code; the
sandbox has no credentials to leak and no network to leak them over.
"""

from __future__ import annotations

import json
import sys

MAX_SAMPLE_ROWS = 10
VALID_SEVERITIES = {"high", "warn", "ok"}

# Builtins the code may use. Everything else — open, eval, __import__ — is gone,
# not merely discouraged.
SAFE_BUILTINS = {
    "len": len, "range": range, "min": min, "max": max, "abs": abs, "round": round,
    "sum": sum, "sorted": sorted, "enumerate": enumerate, "zip": zip,
    "int": int, "float": float, "str": str, "bool": bool,
    "list": list, "dict": dict, "set": set, "tuple": tuple,
    "True": True, "False": False, "None": None,
}


def _apply_resource_limits() -> None:
    """
    CPU and address-space caps. POSIX only; a no-op on Windows dev machines.

    MUST be called *after* numpy/pandas are imported — see main(). Every limit
    here is hostile to a C extension's initialisation and harmless once it has
    finished initialising.
    """
    try:
        import resource  # noqa: PLC0415 — POSIX-only, intentionally imported late
    except ImportError:
        return
    # 25s of CPU: below the parent's 30s wall clock, so a busy loop dies here first.
    resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
    # 3 GiB of *address space* — deliberately looser than it looks. OpenBLAS
    # reserves a large virtual arena at import, which a 1 GiB RLIMIT_AS refused,
    # killing the import outright. Virtual reservations are not resident memory:
    # the real ceiling is the container's `mem_limit: 1500m` cgroup, which caps
    # RSS and is what actually protects the VPS. RLIMIT_AS is only a backstop to
    # turn a runaway allocation into a catchable MemoryError.
    resource.setrlimit(resource.RLIMIT_AS, (3 * 1024 * 1024 * 1024, 3 * 1024 * 1024 * 1024))
    # No forking. The code cannot spawn its way out. Safe to set to 0 only
    # because numpy has already built its (single, see _worker_env) thread pool.
    resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))


def _coerce_result(raw: object) -> dict:
    """
    Force whatever evaluate() returned into the verdict contract, or reject it.

    A verdict that doesn't typecheck is not a verdict. We refuse it here rather
    than let a malformed dict reach the CRM, where a missing severity would once
    have been defaulted to "ok".
    """
    if not isinstance(raw, dict):
        raise ValueError(f"evaluate() must return a dict, got {type(raw).__name__}")

    severity = raw.get("severity")
    if severity not in VALID_SEVERITIES:
        raise ValueError(f"severity must be one of {sorted(VALID_SEVERITIES)}, got {severity!r}")

    try:
        affected = int(raw.get("affected_count", 0))
        total = int(raw.get("total_count", 0))
    except (TypeError, ValueError) as e:
        raise ValueError("affected_count / total_count must be integers") from e

    if affected < 0 or total < 0:
        raise ValueError("counts must be non-negative")
    if affected > total:
        raise ValueError(f"affected_count ({affected}) exceeds total_count ({total})")

    evidence = raw.get("evidence") or {}
    if not isinstance(evidence, dict):
        evidence = {}

    # Cap the evidence payload: it is persisted to risk_card_runs.evidence_json
    # and rendered in the drawer. An LLM asked for "up to 10 rows" will sometimes
    # return the whole frame.
    sample = evidence.get("sample_rows") or []
    if not isinstance(sample, list):
        sample = []
    notes = evidence.get("notes") or []
    if not isinstance(notes, list):
        notes = []

    return {
        "severity": severity,
        "affected_count": affected,
        "total_count": total,
        "finding_summary": str(raw.get("finding_summary") or "—")[:500],
        "evidence": {
            "sample_rows": json.loads(json.dumps(sample[:MAX_SAMPLE_ROWS], default=str)),
            "notes": [str(n)[:500] for n in notes[:20]],
        },
    }


def main() -> int:
    # Import BEFORE _apply_resource_limits(). numpy's OpenBLAS backend builds a
    # thread pool during import; under RLIMIT_NPROC=0 the pthread_create fails,
    # numpy swallows the real error and re-raises the misleading "you should not
    # try to import numpy from its source directory" ImportError — which the
    # except below reported as "sandbox missing dependency: Error importing
    # numpy" on every single hypothesis card. RLIMIT_AS=1GiB refused OpenBLAS's
    # virtual arena for the same net effect. Neither reproduced on Windows dev
    # boxes, where _apply_resource_limits() is a no-op (no `resource` module).
    #
    # Importing first costs nothing: the limits exist to cage the agent-authored
    # code exec()'d below, and they are all in force before that happens.
    try:
        import numpy as np
        import pandas as pd
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"sandbox missing dependency: {e}"}))
        return 0

    _apply_resource_limits()

    try:
        job = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001 — any stdin failure is a bad job
        print(json.dumps({"ok": False, "error": f"bad job payload: {e}"}))
        return 0

    code = job.get("code") or ""
    data = job.get("data") or {}

    try:
        frames = {name: pd.DataFrame(rows or []) for name, rows in data.items()}
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"could not build DataFrames: {e}"}))
        return 0

    # Restricted namespace. The code has pd, np and safe builtins — nothing else.
    namespace: dict = {"__builtins__": SAFE_BUILTINS, "pd": pd, "np": np}

    try:
        exec(compile(code, "<hypothesis>", "exec"), namespace)  # noqa: S102 — the point of the service
        evaluate = namespace.get("evaluate")
        if not callable(evaluate):
            print(json.dumps({"ok": False, "error": "code defines no callable `evaluate`"}))
            return 0
        raw = evaluate(
            frames.get("loans", pd.DataFrame()),
            frames.get("vehicle_states", pd.DataFrame()),
            frames.get("daily_km", pd.DataFrame()),
        )
        print(json.dumps({"ok": True, "result": _coerce_result(raw)}))
    except MemoryError:
        print(json.dumps({"ok": False, "error": "hypothesis exceeded the 1 GiB memory cap"}))
    except Exception as e:  # noqa: BLE001 — a failing hypothesis must not crash the service
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
