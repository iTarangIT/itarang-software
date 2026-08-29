# CRM Security Scanner Agent

A standalone, authorized security-testing agent for the iTarang CRM. It drives a
real browser (Playwright) through the CRM starting at **dealer onboarding**,
actively probes for vulnerabilities, and records findings. Findings surface at
**`/it/security`** and export to Excel / PDF / Word.

> This is **independent** of the NBFC risk engine (`risk_hypotheses` /
> `risk_card_runs`). It shares no tables and no code — only house style.

## What it detects

| Category | Probes |
|---|---|
| Broken access control (`authz`) | cross-role access (dealer → admin), IDOR on ID-scoped KYC/co-borrower/onboarding routes |
| Sensitive data exposure (`exposure`) | unauth PII endpoints (e.g. `/api/dealer-onboarding/list`), exposed `/api/debug/*` & `/api/test-*` |
| Injection / XSS (`injection`) | reflected XSS (unescaped param reflection), leaked SQL/DB errors |
| Upload & headers (`upload_headers`) | missing CSP/HSTS/X-Frame-Options/nosniff/Referrer-Policy + cookie flags; spoofed-content-type upload (aggressive) |

**Severity is decided by deterministic probe rules, never by the LLM.** The
LangGraph agent's LLM only plans extra targets and narrates/dedups findings.

## Design principle

- `src/lib/security/probes/*` — deterministic probes emit raw findings + severity.
- `src/lib/security/agent/graph.ts` — LangGraph: `plan_targets → run_probes → llm_triage → write_findings`. Works with **or without** `OPENAI_API_KEY` (LLM steps no-op if absent).
- `src/lib/security/scan-run.ts` — run lifecycle + single-flight lock (partial unique on `(target_env) WHERE status='running'`).

## Setup

1. **Apply the migration** `drizzle/E-215_security_scanner.sql` to the target DB
   (Supabase SQL editor or the team runner). Additive + idempotent.
2. **Install browsers** on the host that runs scans:
   ```bash
   npx playwright install chromium
   ```
3. **Env vars** (add to `.env.local`):

   | Var | Default | Purpose |
   |---|---|---|
   | `SECURITY_SCAN_BASE_URL` | `http://localhost:3000` | Scan target. Use `https://sandbox.itarang.com` for sandbox. |
   | `SECURITY_ALLOW_PROD` | _(unset)_ | Must be `1` to scan `crm.itarang.com`. Otherwise refused. |
   | `SECURITY_SCAN_MODE` | `safe` | `safe` = read-only probes; `aggressive` = also state-mutating probes (uploads). |
   | `SECURITY_OPENAI_MODEL` | `gpt-4o-mini` | LLM for planning/triage. Reuses `OPENAI_API_KEY`. |
   | `OPENAI_API_KEY` | _(existing)_ | Optional — without it the deterministic probes still run. |

   Login credentials reuse the e2e suite's vars (`E2E_<ROLE>_EMAIL` /
   `E2E_<ROLE>_PASSWORD`) with the seeded sandbox users as fallback
   (dealer/ceo/sales_head/admin). A role with no password is skipped.

## Running

**CLI (primary):**
```bash
npm run security:scan                       # localhost, safe mode
npm run security:scan -- --target=sandbox   # sandbox.itarang.com
npm run security:scan -- --url=http://localhost:3000 --mode=aggressive
```

**In-app:** the **Run Scan** button on `/it/security` (admin/ceo). Runs
in-process — only works where Chromium can launch (dev machine / VPS worker),
not on Vercel serverless; there it returns a 501 pointing you to the CLI.

## Safety

- Prod is hard-guarded (`SECURITY_ALLOW_PROD=1`).
- `safe` mode (default) runs only non-mutating probes.
- One live scan per environment (DB lock).

---

# Part 2 — Live-attack detection (E-216)

The scanner above finds vulnerabilities *proactively*. This part is the runtime
alarm: it watches real traffic and records/blocks attacks as they happen. It
surfaces at **`/it/security/live`** ("Live Attacks" tab).

## How it works

```
every request ──▶ src/middleware.ts
                    ├─ trackRequest()  (rate-watch.ts)  counts EVERY request per IP
                    │      └─ rate_flood / path_enumeration / auth_bruteforce
                    └─ detectThreat()  (detect.ts)      inspects THIS request
                           │  injection (SQL/NoSQL/command/XSS/XXE/JNDI), traversal,
                           │  null-byte, SSRF, file-inclusion, CRLF, prototype
                           │  pollution, scanner-UA, sensitive-file probe, method
                           │  abuse, off-host redirect, unauth sensitive endpoint
                           ├─ blocks the request (403 / 429) if high-confidence  [block mode]
                           └─ postSecurityEvent() ──▶ POST /api/internal/security-events
                                                        (Node) writes security_events,
                                                        escalates bursts → critical,
                                                        emails a rate-limited alert
```

Both layers are Edge-safe and run before the `/api` early-return, so API traffic
is covered too. A payload signal wins when both fire on one request.

## The event taxonomy

**Payload rules** — `detect.ts`, one request at a time:

| Event type | Severity | Action |
|---|---|---|
| `jndi_injection` (Log4Shell `${jndi:…}`) | critical | blocked |
| `sql_injection`, `xss`, `path_traversal`, `null_byte`, `command_injection`, `ssrf`, `lfi_rfi`, `nosql_injection`, `crlf_injection`, `proto_pollution`, `xxe`, `sensitive_file_probe` | high | blocked |
| `scanner_ua` (sqlmap, nikto, nuclei, …) | high | blocked |
| `method_abuse` (TRACE/TRACK/CONNECT) | medium | blocked |
| `sensitive_unauth` (no session on a PII endpoint) | medium | logged |
| `open_redirect` (redirect param pointing off-host) | low | logged |

**Volumetric / behavioural rules** — `rate-watch.ts`, traffic shape per IP:

| Event type | Default trigger | Severity | Action |
|---|---|---|---|
| `rate_flood` | 300 requests / min from one IP | high | logged¹ |
| `auth_bruteforce` | 15 hits / min on `/login`, `/forgot-password`, `/change-password`, `/api/auth/*` | high | logged |
| `path_enumeration` | 60 distinct paths / min | medium | logged |

¹ set `SECURITY_RATE_BLOCK=1` to return **429 + Retry-After** instead. Off by
default because a dealer's office behind one NAT IP can legitimately be noisy.

Thresholds are tunable: `SECURITY_RATE_FLOOD_PER_MIN`, `SECURITY_RATE_AUTH_PER_MIN`,
`SECURITY_RATE_PATHS_PER_MIN`.

Each IP emits **at most one event per signal per 5 minutes** — a flood is
thousands of requests, and one row each would make the detector the DoS. The
observed counts ride along in `evidence` instead.

Middleware runs on the Edge runtime and can't reach Postgres, so it fires the
event to a Node ingest route. The detection rules are deliberately **tight** —
block-mode rules only match payloads that essentially never appear in real CRM
traffic.

## OFF by default — enabling it

Because this hooks into request handling and can block requests, the whole layer
is disabled until you opt in:

| Var | Default | Purpose |
|---|---|---|
| `SECURITY_DETECTION_ENABLED` | _(off)_ | Set to `1` to turn detection on. |
| `SECURITY_INTERNAL_SECRET` | _(required)_ | Random string shared between middleware and the ingest route; the ingest rejects unsigned posts. **Detection does nothing until this is set.** |
| `SECURITY_DETECTION_MODE` | `block` | `block` = 403 high-confidence attacks; `monitor` = log everything, block nothing (safety valve). |
| `SECURITY_INSPECT_BODY` | _(off)_ | Set to `1` to ALSO scan POST/PUT/PATCH request **bodies** (JSON / form / text, ≤100 KB) for injection. Reads a clone so the original body still reaches the route. Adds a small per-request cost on mutating methods — that's why it's separately opt-in. Body rules are narrower than URL rules: traversal, CRLF, open-redirect and file-probe are skipped because they false-positive on real text fields. |
| `SECURITY_RATE_BLOCK` | _(off)_ | Set to `1` to answer `rate_flood` with **429 + Retry-After: 60** instead of only logging it. |
| `SECURITY_RATE_FLOOD_PER_MIN` | `300` | Requests per minute from one IP before `rate_flood` fires. |
| `SECURITY_RATE_AUTH_PER_MIN` | `15` | Auth-surface requests per minute before `auth_bruteforce` fires. |
| `SECURITY_RATE_PATHS_PER_MIN` | `60` | Distinct paths per minute before `path_enumeration` fires. |
| `SECURITY_ALERT_EMAIL` | `MAIL_FROM` / `it@itarang.com` | Where critical-event alerts are emailed (reuses `sendEmail`). |
| `SECURITY_ALERT_WHATSAPP` | _(off)_ | Phone number (E.164) to also receive a WhatsApp alert on critical events. |
| `SECURITY_ALERT_WHATSAPP_TEMPLATE` | _(none)_ | Approved Meta template name for the alert. **Recommended** — without it a plain-text send only lands inside the 24h session window. `_LANG` sets the template language (default `en`). |

To enable (dev):
```bash
SECURITY_DETECTION_ENABLED=1
SECURITY_INTERNAL_SECRET=<any long random string>
# optional: SECURITY_DETECTION_MODE=monitor   # while you build trust
```
Restart the server after setting these.

## Testing it

With detection on, from another shell:
```bash
# Payload rules
curl "http://localhost:3000/api/health?q=' OR 1=1"              # sql_injection
curl -A "sqlmap/1.7" "http://localhost:3000/dealer-portal"      # scanner_ua
curl "http://localhost:3000/api/health?x=\${jndi:ldap://x/a}"   # jndi_injection (critical)
curl "http://localhost:3000/api/health?u=http://169.254.169.254" # ssrf
curl "http://localhost:3000/.env"                                # sensitive_file_probe
curl -X TRACE "http://localhost:3000/"                           # method_abuse

# Volumetric rule — 350 requests trips the 300/min default
for i in $(seq 1 350); do curl -s -o /dev/null "http://localhost:3000/api/health"; done
```
Then open `/it/security/live`.

Note the flood test writes exactly **one** `rate_flood` row, not 50 — that's the
per-IP emit cooldown working. `evidence.requests` carries the real count.

## What it does NOT catch

- **Anything that bypasses the app.** Someone using leaked credentials to
  connect straight to RDS on 5432, to S3, to Razorpay's API, or to Supabase with
  the service-role key never touches middleware — zero events here. That needs
  CloudTrail, RDS logs and the provider dashboards.
- **A stolen session cookie.** It is a *valid* authenticated request and looks
  identical to legitimate use. No rule can distinguish it.
- **Failed passwords.** Sign-in goes browser→Supabase directly, so wrong-password
  attempts are invisible; `auth_bruteforce` only sees the *volume* of requests
  reaching the auth routes. Supabase auth logs have the rest.
- **Real DDoS mitigation.** `rate_flood` makes a flood visible, but by the time
  middleware runs the connection is accepted and the request parsed. Volumetric
  defence belongs upstream — Cloudflare in front of the domain (then firewall
  80/443 to Cloudflare ranges only) and `limit_req` in nginx on the VPS.
- **Business-logic abuse** by an authenticated user with a legitimate role.

It is a lightweight WAF-style detector, not a full IDS. Pair it with the scanner
(fix the doors) for defence in depth.

## Alerts

Critical events email `SECURITY_ALERT_EMAIL`, rate-limited to one per source IP
per 15 minutes (so a flood can't spam you). WhatsApp alerts can be added by
wiring the existing WhatsApp sender with an approved template — the alert call
site is `sendCriticalAlert()` in the ingest route.

---

# Part 3 — AI resolution chat + auto-apply fix (E-218)

Every finding card opens a chat (`FindingDrawer` → `ResolutionChat`) where a
human discusses the vulnerability with an agent that has **read the actual
affected source file**. When they agree on a fix, **Resolve & Apply** writes the
fix to disk and marks the finding `resolved` — the card flips to **"Problem
Resolved"** and stores a report of exactly what changed.

```
FindingDrawer ▸ ResolutionChat
   │  POST /api/it/security/findings/[id]/chat
   │     └─ locateSourceForTarget(target_url)  → reads the real route file
   │        runResolveTurn(...)  (ChatOpenAI gpt-4o-mini, src/lib/security/chat)
   │        → reply + optional PROPOSED_FIX { file, search, replace, explanation }
   │  [Resolve & Apply] POST /api/it/security/findings/[id]/resolve
   │     └─ re-locate file server-side (model path NOT trusted)
   │        require search occurs exactly once → .bak backup → write → verify
   │        rollback on any failure; else status=resolved + resolution_report
   ▼
security_finding_messages (chat)   security_findings.resolution_* (report)
```

## Safety — this writes live source

Auto-apply is **off by default** and hard-railed:

| Var | Default | Purpose |
|---|---|---|
| `SECURITY_AUTOFIX_ENABLED` | _(off)_ | Set to `1` to let **Resolve** write the fix to disk. With it off, Resolve returns the diff to apply by hand (409). |

- The file is **re-located server-side** from the finding's `target_url`; the
  model's suggested path is never trusted, and edits are refused outside repo
  `src/` or on non-`.ts/.tsx` files.
- The edit is a **deterministic single-occurrence** string replacement — if
  `search` matches zero or many places, it refuses (409) instead of guessing.
- A `.bak` backup is written and the change **verified**; any failure rolls the
  file back unchanged.
- On a **standalone prod build** there are no source files, so locate returns
  null and Resolve refuses — the chat still produces a diff a developer commits.

Reuses `OPENAI_API_KEY` + `SECURITY_OPENAI_MODEL`. Without a key the chat returns
templated remediation text (no auto-apply). **Commit resolved diffs promptly** so
the change is reviewed in git.
