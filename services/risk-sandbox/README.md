# risk-sandbox

Executes agent-authored Python against tenant data and returns a deterministic
verdict. The NBFC risk engine's LangGraph agent proposes hypotheses and writes
the `evaluate()` function that tests each one; this service is where that
function actually runs.

## Why it matters

Before this service existed in the repo, `NBFC_SANDBOX_URL` had never been
configured, so `sandboxHealthy()` always returned false and the risk engine fell
back to asking `gpt-4o-mini` to *state* the severity and the affected/total
counts itself. Those numbers landed in the same DB columns and the same red chip
as hand-computed ones, with nothing to tell them apart. On `database-2`, all 84
LLM-era rows in `risk_card_runs` came out `severity='ok'` — not one warning
across 84 evaluations, which is the signature of a broken engine, not a healthy
portfolio.

E-185 made the CRM report `inconclusive` instead of guessing. This service is
what turns those inconclusive cards back into real verdicts.

## Contract

Consumed by `src/lib/ai/langgraph/risk-sandbox-client.ts`.

```
GET  /healthz  -> 200 {"ok": true, "auth": true}

POST /execute
  Authorization: Bearer $SANDBOX_TOKEN
  { "hypothesis_slug": "...",
    "code": "def evaluate(loans, vehicle_states, daily_km): ...",
    "data": { "loans": [...], "vehicle_states": [...], "daily_km": [...] } }

  -> { "ok": true,  "result": { "severity": "high"|"warn"|"ok",
                                "affected_count": int, "total_count": int,
                                "finding_summary": str,
                                "evidence": { "sample_rows": [...], "notes": [...] } },
       "elapsed_ms": int }
  -> { "ok": false, "error": "...", "elapsed_ms": int }
```

The caller ships the DataFrames **with** the code. The sandbox has no database
connection, no credentials, and no outbound network — there is nothing here to
steal and no way to phone home with it.

`ok: false` is not a failure of the service; it is a refused or failed
hypothesis, and the CRM renders it as `error` / `inconclusive`. The service only
returns 5xx if it is itself broken.

## Security model

The code we execute was written by a language model seconds earlier. Assume it
is hostile.

1. **Auth.** Bearer token, constant-time compared. The service *refuses to
   start* without `SANDBOX_TOKEN` unless `SANDBOX_ALLOW_NO_AUTH=1` is set
   (local dev only). The previous VPS deployment had no auth at all.
2. **Static gate** (`validator.py`). An allowlist AST walk, applied before
   anything executes. No imports, no `open`/`eval`/`exec`/`__import__`, no
   dunder attribute access (the classic `().__class__.__bases__` escape), no
   module-level statements — only a single `def evaluate(...)`. Anything not
   explicitly permitted is refused, which surfaces as an honest `inconclusive`
   card rather than a wrong verdict.
3. **Process isolation** (`worker.py`). Executed in a short-lived child process
   with a restricted `__builtins__`, killed at 30s wall clock. On Linux it also
   gets `RLIMIT_CPU` 25s, `RLIMIT_AS` 1 GiB and `RLIMIT_NPROC` 0 (cannot fork).
   The API process never `exec()`s the code itself.
4. **Verdict validation.** A result that isn't a well-formed verdict is refused,
   not defaulted. `severity` must be one of high/warn/ok; counts must be
   non-negative integers with `affected <= total`; `sample_rows` is capped at 10.
5. **No env inheritance.** The worker is spawned with a bare environment —
   `SANDBOX_TOKEN` is not visible to the code being run.
6. **Container hardening** (`docker-compose.yml`). Non-root user, read-only
   filesystem, all capabilities dropped, `no-new-privileges`, 64 pids, 1.5 GB
   memory, bound to `127.0.0.1` only.

Layers 2 and 3 are independent: the AST gate is not the only thing standing
between a malicious `evaluate()` and the host.

## Run it

### Local dev

```bash
cd services/risk-sandbox
python -m venv .venv && ./.venv/bin/pip install -r requirements.txt
SANDBOX_TOKEN=local-dev-token ./.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8091
```

Then in the CRM's `.env.local`:

```
NBFC_SANDBOX_URL=http://127.0.0.1:8091
NBFC_SANDBOX_TOKEN=local-dev-token
```

Check it: `curl localhost:3000/api/health | jq .deps.sandbox` should report ok.

### VPS (production / sandbox)

The CRM runs on the same Hostinger box, so the service binds to loopback and is
never exposed to the internet.

```bash
# on the VPS
cd /opt/risk-sandbox            # git clone or rsync services/risk-sandbox/ here
export SANDBOX_TOKEN="$(openssl rand -hex 32)"
docker compose up -d --build
curl -s 127.0.0.1:8091/healthz   # {"ok":true,"auth":true}
```

Put the same token in the CRM's env as `NBFC_SANDBOX_TOKEN`, set
`NBFC_SANDBOX_URL=http://127.0.0.1:8091`, and restart the CRM (`pm2 restart
itarang-crm-web`).

**This replaces `phase6_risk_sandbox.sh`**, an unversioned script that lived
only on the VPS and whose contents are not recoverable from this repo. Delete it
once this is running.

## Testing a change

There is no test runner in this repo. Exercise it by hand against the live
service — the cases that matter are: a real hypothesis (should compute), `import
os` / `open()` / `__class__` escapes (should be refused by the validator), an
invalid severity or `affected > total` (should be refused by the verdict
validator), an infinite loop (should be killed at 30s), and a request with no or
wrong token (should 401).
