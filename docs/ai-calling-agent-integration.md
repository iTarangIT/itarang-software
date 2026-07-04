# iTarang CRM — AI Calling Agent Integration Guide

> **Status:** Internal assessment for an external AI Calling Agent integration.
> **Audience:** Integration vendor + iTarang engineering.
> **Important framing:** iTarang is an **internal Next.js CRM**, not a public SaaS API
> platform. It authenticates browser users via Supabase **session cookies** and machine
> callers via **shared secrets** (cron / webhook tokens). There is **no public API-key
> issuance, no OAuth2, and no self-service developer portal** today. The CRM also already
> runs a full AI-dialer + campaign engine around **Bolna AI** (and ElevenLabs), so a new
> vendor is best modeled as **a new calling provider**, not a greenfield integration.

---

## 0. TL;DR — what exists vs. what must be built

| Vendor asked for | Reality in the codebase | Action |
|---|---|---|
| Production / staging base URLs | Exist (deployed app), but no documented public API host | **Confirm with infra** (see §1) |
| API Key | ❌ Not supported for external callers | **Build** an API-key/HMAC scheme, or reuse webhook-secret pattern |
| Bearer token | ✅ Only for cron (`CRON_SECRET`) and webhook secrets | Reuse pattern for M2M |
| OAuth2 / Client ID+Secret | ❌ Does not exist | Not recommended to build for one vendor |
| Create campaign | ✅ Exists (`POST /api/ai-dialer/start`, `/lists/create`) but **session-auth only** | **Add M2M auth** |
| Add leads to campaign | ❌ Queue is frozen at creation | **Build** if needed |
| Start campaign | ✅ Exists | **Add M2M auth** |
| Campaign status | ✅ Exists (`GET /api/ai-dialer/campaigns/[id]`) | **Add M2M auth** |
| Create / update / fetch leads | ✅ Several endpoints exist | **Add M2M auth** |
| Webhooks (call status) | ✅ CRM **receives** call results (it's the consumer, Bolna-style) | Vendor POSTs results here |
| Rate limits | ❌ None implemented | Document "no limit / be reasonable" or build |

**Recommended integration shape:** register the vendor as a **calling provider** mirroring
the existing Bolna flow — (1) CRM triggers a call to the vendor, (2) vendor calls the dealer,
(3) vendor POSTs the result back to a CRM webhook. The campaign/queue state machine is already
built and provider-aware.

---

## 1. Base URLs

There is no dedicated API subdomain. The API routes are served by the same Next.js app under `/api/*`.

| Environment | Host | Notes |
|---|---|---|
| **Production** | `https://<prod-domain>` | Hostinger VPS, PM2 (`prod-web`). **Confirm exact domain with infra.** |
| **Sandbox/Staging** | `https://<sandbox-domain>` | Same 8 GB VPS, PM2 (`sandbox-web`). Shared with prod. |
| Local dev | `http://localhost:3000` | `npm run dev` |

> ⚠️ Sandbox and production **share one VPS**. Vercel is configured (`vercel.json`) but the live
> deployment is PM2 on Hostinger; **Vercel cron jobs do not fire there** — recurring jobs run as
> in-process tickers. Don't assume Vercel-hosted behavior.

API base path for everything below: `{HOST}/api`.

---

## 2. Authentication — current state

There is **no middleware auth on `/api/*`** — `/api` is treated as public at the middleware layer,
and **each route handler enforces its own auth.** Three patterns exist:

### 2a. Session-cookie auth (interactive / browser) — *not usable by the vendor*
Most endpoints call `requireAuth()` / `requireRole([...])`, which validate a **Supabase session
cookie** via `supabase.auth.getUser()`. An external machine has no such cookie, so these endpoints
are **not directly callable** by the vendor as-is.

### 2b. Bearer shared-secret (cron / internal) — *the reusable M2M pattern*
Cron and internal routes accept:
```
Authorization: Bearer ${CRON_SECRET}
```
Example: `POST /api/cron/ai-dialer`, `GET /api/cron/dialer-poll`. This is the **closest existing
pattern** to a machine token and is the recommended basis for vendor auth.

### 2c. Webhook signature secrets (inbound machine-to-machine) — *how the vendor sends results back*
The CRM verifies inbound webhooks with a shared secret, timing-safe compared:
- **Bolna:** `Authorization: Bearer ${BOLNA_WEBHOOK_SECRET}` → `/api/bolna/webhook`
- **Razorpay:** `x-razorpay-signature` (HMAC-SHA256 of body)
- **WhatsApp:** `x-hub-signature-256`

> In non-production, webhook secret checks are **bypassed** for dev convenience. Production enforces them.

### What does NOT exist
- ❌ No API-key (`x-api-key`) auth for external callers
- ❌ No OAuth2 / client-credentials / Client ID+Secret
- ❌ No token issuance/rotation UI or self-service credential generation
- ❌ No per-caller rate limiting

### Recommended auth to add for the vendor (smallest lift)
Add a single shared secret `AI_AGENT_API_KEY` (env var) and a helper that checks
`Authorization: Bearer ${AI_AGENT_API_KEY}` at the top of the specific endpoints the vendor needs.
For inbound results, issue an `AI_AGENT_WEBHOOK_SECRET` exactly like `BOLNA_WEBHOOK_SECRET`.
This mirrors patterns already in the codebase — no new framework required.

**Credential generation steps (for iTarang ops):**
1. Generate two random secrets: `openssl rand -hex 32` (one for outbound API auth, one for the inbound webhook).
2. Add `AI_AGENT_API_KEY` and `AI_AGENT_WEBHOOK_SECRET` to `shared/.env` on the VPS (sandbox env is seeded once — edit the box file, then `pm2 reload sandbox-web`; the GitHub env secret does **not** propagate).
3. Share the secrets with the vendor over a secure channel.
4. (Engineering) Gate the chosen endpoints on the bearer check.

---

## 3. Existing AI-calling architecture (model your integration on this)

The CRM is **provider-aware** (`provider: 'bolna' | 'elevenlabs'`). Flow per call:

```
CRM (triggerCall) ──POST──▶ Provider API ──places call──▶ Dealer
                                                              │
Provider ◀──── transcript/recording/status ──────────────────┘
   │
   └──POST result──▶ CRM webhook  ──▶ finalizeCall(): LLM transcript analysis,
                                       intent scoring, lead status update,
                                       campaign auto-advance to next lead
```

Key tables (`src/lib/db/schema.ts`):
- `dialer_campaigns` — campaign header (status: `draft|running|completed|stopped|failed`, `provider`, counters)
- `dialer_campaign_leads` — per-lead queue rows (`pending|calling|completed|failed`, `bolna_call_id`, `intent_score`)
- `ai_call_logs` — per-call result (transcript, summary, recording_url, duration, intent_score, band, signals)
- `dealer_leads` — the lead record (call history appended to `follow_up_history`)

Core files: `src/lib/ai/bolna_ai/triggerCall.ts`, `finalizeCall.ts`, `webhookHandler.ts`,
`src/lib/queue/campaignTracker.ts`, `advanceCampaign.ts`.

---

## 4. Campaign APIs (exist — currently session/role-gated)

> All require an authenticated session today (roles: `admin, ceo, business_head, sales_head,
> sales_manager`). To let the vendor call them, add the bearer check from §2.

### Create + start a campaign (region-targeted)
`POST /api/ai-dialer/start`
```jsonc
// Request
{
  "queueIds": ["DL-...","DL-..."],   // dealer_leads IDs to dial
  "provider": "bolna",                // would become "ai_agent" for the vendor
  "category": "optional-string",
  "location": "optional-string",
  "region": { /* optional saved-group metadata */ }
}
// Response
{ "success": true, "provider": "bolna", "queued": 2,
  "campaignId": "uuid", "firstCallPlaced": true, "firstCallError": null }
```

### Create a campaign from an uploaded list (CSV/XLSX)
`POST /api/ai-dialer/lists/create` (multipart form-data: `file`, `name`) → creates a `draft` campaign.
`POST /api/ai-dialer/lists/[id]/start` `{ "provider": "bolna" }` → launches it.

### Campaign status
- `GET /api/ai-dialer/campaigns` — paginated list (`?provider=`, `?kind=list`, page params).
- `GET /api/ai-dialer/campaigns/[id]` — header stats for one campaign.
- `GET /api/ai-dialer/campaigns/[id]/leads?bucket=all|pending|calling|completed|failed&page=N` — per-lead detail (status, callOutcome, intentScore, durationSeconds).

### Campaign control
- `POST /api/ai-dialer/campaigns/[id]/advance` — place the next call manually.
- `POST /api/ai-dialer/campaigns/[id]/stop` — force-stop (drains `calling` → `failed`).
- `POST /api/ai-dialer/campaigns/[id]/resume` — resume a stopped campaign.
- `POST /api/ai-dialer/campaigns/[id]/recall-failed` — clone failed leads into a new retry campaign.
- `POST /api/ai-dialer/campaigns/[id]/export.xlsx` — Excel export.

### Place a single call (no campaign)
`POST /api/bolna/call`
```jsonc
// Request
{ "phone": "+91XXXXXXXXXX", "leadId": "DL-...", "scheduledAt": null, "bypassIdempotency": false }
// Response
{ "success": true, "call_id": "provider-execution-id", "error": null }
```
> Idempotency guard: once-per-`(lead, phone, day)` via Redis (TTL 25h). Set `bypassIdempotency:true` to override.

### Does NOT exist
- ❌ Add leads to an **already-created** campaign — the queue is frozen at creation. Build if needed.
- ❌ Bulk pause/resume across campaigns.

---

## 5. Lead APIs

There are **two parallel lead systems**. For an AI-dialer integration, use the **Inside Sales /
`dealer_leads`** system (that's what the dialer dials).

### Create lead (inside-sales — primary for dialer)
`POST /api/inside-sales/lead/create` (roles: `inside_sales_rep, admin`)
```jsonc
// Request
{
  "dealer_name": "Ramesh Traders",      // required, 2–200 chars
  "phone": "9876543210",                 // required, exactly 10 digits
  "shop_name": "Ramesh Auto",            // optional
  "city": "Pune", "state": "Maharashtra",// optional
  "interest_level": "hot",               // optional: hot|warm|cold
  "language": "Hindi"                     // optional
}
// Response
{ "success": true, "data": { "id": "DL-{timestamp}-{nanoid}" } }
// 409 if phone already exists
```

### Bulk import leads (best fit for a vendor pushing many leads)
`POST /api/leads/import`
```jsonc
// Request
{ "leads": [
  { "dealer_name": "...", "phone": "9876543210", "shop_name": "...",
    "city": "...", "state": "...", "area": "...", "pincode": "...", "language": "..." }
]}
// Response
{ "success": true, "inserted": 12, "skipped": 3 }   // skips missing-phone + dedups by phone
```

### Fetch a lead (full bundle)
`GET /api/inside-sales/lead/[id]` → `{ success, data: { lead, current_commercials, commercials_history, touchpoints, status_history } }`.
The `lead` object includes `lead_status`, `interest_level`, `final_intent_score`, `current_owner_*`,
`total_attempts`, `next_follow_up_at`, `ai_session_id`, timestamps, etc.

### Update lead
`PUT /api/leads/[id]` (sales roles) — note this targets the **other** (dealer-portal) lead table:
```jsonc
{ "lead_status": "contacted", "interest_level": "warm",
  "owner_contact": "+919876543210", "city": "Pune", "state": "Maharashtra" }
```
Inside-sales leads are mutated via **action endpoints** instead of a generic PUT:
`/claim`, `/mark-converted`, `/mark-lost`, `/reassign`, `/transfer-asm`, `/commercials`.

### Check duplicate
`GET /api/leads/check-duplicate?phone=...` → returns matching leads (scoped to the calling dealer).

> **All lead endpoints are session/role-gated today** — same caveat as §4; add the bearer check for the vendor.
> Standard envelope: success → `{ "success": true, "data": ... }`; error → `{ "success": false, "error": "...", "status": 4xx }`.

---

## 6. Webhooks — the CRM is the *receiver*

The vendor's call results come **into** the CRM (the CRM does not currently emit outbound webhooks
to notify the vendor of CRM-side changes). Mirror Bolna:

### Inbound: call status / result → CRM
`POST /api/bolna/webhook` (primary). Auth: `Authorization: Bearer ${BOLNA_WEBHOOK_SECRET}`.
Returns `202` immediately, processes in the background, **exactly-once** via Redis dedup on call id.

Expected payload (the vendor should emit this shape, or we add an adapter):
```jsonc
{
  "id": "execution-id",                  // your call/execution id
  "status": "completed",                 // completed|failed|no_answer|busy|in-progress|ringing
  "user_number": "+91XXXXXXXXXX",
  "transcript": "Agent: Hello...\nUser: Hi...",
  "recording_url": "https://...",
  "duration": 45,                         // seconds
  "messages": [                           // optional turn-by-turn
    { "role": "agent", "text": "...", "timestamp": 0 },
    { "role": "user",  "text": "...", "timestamp": 3 }
  ]
}
```
On receipt the CRM analyzes the transcript (LLM), computes an intent score/band, appends to the
lead's `follow_up_history`, writes `ai_call_logs`, and **auto-advances the campaign** to the next lead.

Two legacy receivers also exist (`POST /api/webhooks/bolna`, `POST /api/ceo/ai-dialer/webhook/bolna`)
— for a new vendor we'd stand up a clean `POST /api/ai-agent/webhook` modeled on the primary one.

### Polling backstop
If a webhook is missed, `GET /api/cron/dialer-poll` (every minute) asks the provider for in-flight
call status and runs the same finalization. The vendor would need a "get call status" GET endpoint
for us to poll.

### Not supported
- ❌ Outbound webhooks **from** the CRM (lead updated / campaign updated → notify vendor). Build if the vendor needs push.

---

## 7. Rate limits & operational notes

- **No application-level rate limiting** exists. Be conservative; the dialer itself self-throttles
  (1s spacing between calls, circuit-breakers on provider 5xx and Upstash quota).
- **Idempotency:** once-per-`(lead, phone, day)` on call placement (Redis, 25h TTL).
- **Environments share a VPS** — load on sandbox affects prod. Coordinate load tests.
- **Secrets live in `shared/.env` on the box**, seeded once; changing the GitHub env secret does not propagate.

---

## 8. Recommended next steps

1. **Decide the integration direction:** Is the vendor (a) a *new calling provider* the CRM
   dispatches to (recommended — reuses the campaign engine), or (b) an external system that *pushes
   leads and reads status*? This determines which endpoints need M2M auth.
2. **Add machine auth** (`AI_AGENT_API_KEY` bearer check) to the specific endpoints in scope — small,
   localized change following the existing `CRON_SECRET` pattern.
3. **Stand up `POST /api/ai-agent/webhook`** (copy of the Bolna receiver) with `AI_AGENT_WEBHOOK_SECRET`.
4. **Add `'ai_agent'` to the provider enum** and a `triggerAiAgentCall()` mirroring `triggerBolnaCall()`,
   if going with direction (a).
5. **Confirm production & sandbox domains** with infra and fill them into §1.
6. (Optional) Build "add leads to running campaign" and outbound CRM→vendor webhooks if required.

---

*Generated from a codebase audit on 2026-06-19. Endpoint paths derived from `src/app/api/**`;
auth model from `src/middleware.ts` + `src/lib/auth-utils.ts`; provider flow from `src/lib/ai/bolna_ai/**`
and `src/lib/queue/**`.*
