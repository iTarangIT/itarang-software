# iTarang CRM — Discord Bot API (`/api/bot/*`)

A dedicated, key-authenticated API surface for the AI-call-management Discord bot.
It wraps the CRM's existing AI-dialer + campaign engine, so campaigns created from
the bot appear in the CRM exactly like dashboard-created ones — attributed to a
**"Discord Bot"** service user.

---

## 1. Bot environment variables

```env
CRM_API_URL=https://<crm-host>     # base URL of the deployed CRM (no trailing slash)
CRM_API_KEY=<shared secret>        # must equal BOT_API_KEY on the CRM server
```

`<crm-host>` — pending infra's prod-vs-sandbox decision. Endpoints below are relative to `${CRM_API_URL}`.

## 2. Server setup (one-time, iTarang side)

1. **Set the shared secret.** Generate one (`openssl rand -hex 32`) and add it to the
   CRM's environment as `BOT_API_KEY`. On the VPS this is `shared/.env` (edit on the box,
   then `pm2 reload sandbox-web` / `prod-web` — the GitHub env secret does **not** propagate).
   Hand the same value to the bot as `CRM_API_KEY`.
2. **Seed the service user.** Apply `drizzle/E-170_discord_bot_service_user.sql` via the
   **pgAdmin Query Tool against AWS RDS** (the `users` table lives on RDS, not Supabase).
   Idempotent — safe to re-run. Without it, bot campaigns still work but show no
   "triggered by" name.

> **Fail-closed:** if `BOT_API_KEY` is unset on the server, every `/api/bot/*` call returns
> `503`. There is no dev bypass — set it in `.env.local` for local testing.

## 3. Authentication

Every request sends:
```
Authorization: Bearer ${CRM_API_KEY}
```
Missing/wrong key → `401`. Server key not configured → `503`. The key is compared
timing-safely. Existing dashboard endpoints are **unchanged** and remain session-authed.

## 4. Response envelope

```jsonc
// success
{ "success": true,  "data": { ... }, "timestamp": "2026-06-19T..." }
// error
{ "success": false, "error": { "message": "..." }, "timestamp": "..." }
```

## 5. Endpoints (Discord command → API)

| Discord command | Method & path |
|---|---|
| `/upload-leads` | `POST /api/bot/campaigns/upload` |
| `/start-campaign` | `POST /api/bot/campaigns/{id}/start` |
| `/pause-campaign` | `POST /api/bot/campaigns/{id}/pause` |
| `/resume-campaign` | `POST /api/bot/campaigns/{id}/resume` |
| `/status` | `GET /api/bot/campaigns/{id}/status` |
| `/progress` | `GET /api/bot/campaigns/{id}/progress` |
| `/live-calls` | `GET /api/bot/campaigns/{id}/live-calls` |
| `/qualified` | `GET /api/bot/campaigns/{id}/qualified` |
| `/retry-failed` | `POST /api/bot/campaigns/{id}/retry-failed` |
| list campaigns | `GET /api/bot/campaigns` |

### `POST /api/bot/campaigns/upload` — create campaign from Excel
`multipart/form-data`: `name` (string), `file` (`.csv` / `.xlsx` / `.xls`, ≤ 5 MB).
Creates a **draft** campaign (held until `/start`). A phone column with valid 10-digit
Indian mobiles is required; existing leads are reused by phone.
```jsonc
// 200
{ "success": true, "data": {
  "campaignId": "camp_...", "name": "June Dealers", "status": "draft",
  "total": 120, "imported": 95, "reused": 22, "invalid": 3, "queued": 117
}}
```
Curl:
```bash
curl -X POST "$CRM_API_URL/api/bot/campaigns/upload" \
  -H "Authorization: Bearer $CRM_API_KEY" \
  -F "name=June Dealers" -F "file=@leads.xlsx"
```

### `POST /api/bot/campaigns/{id}/start` — begin dialing
Body (optional): `{ "provider": "elevenlabs" | "bolna" }`. **Defaults to `elevenlabs`.**
Only a draft starts; a re-call returns `{ status, alreadyStarted: true }`.
```jsonc
{ "success": true, "data": {
  "campaignId": "camp_...", "status": "running", "provider": "elevenlabs",
  "queued": 117, "firstCallPlaced": true, "firstCallError": null
}}
```

### `POST /api/bot/campaigns/{id}/pause` — stop dialing
Drains in-flight calls, flips campaign to `stopped`; pending leads are preserved for resume.
→ `{ campaignId, status: "stopped" }` (or `{ status, alreadyTerminal: true }`).

### `POST /api/bot/campaigns/{id}/resume` — continue a paused campaign
Resumes only a `stopped` campaign with pending leads (never re-dials completed/failed).
→ `{ campaignId, status: "running", queued, firstCallPlaced, firstCallError }`.
`400` if not stopped or nothing pending.

### `GET /api/bot/campaigns/{id}/status` — header stats
```jsonc
{ "success": true, "data": {
  "id": "camp_...", "name": "June Dealers", "status": "running",
  "provider": "elevenlabs", "category": null,
  "totalLeads": 117, "callsMade": 40, "completedLeads": 38, "failedLeads": 2,
  "startedAt": "...", "completedAt": null, "triggeredByName": "Discord Bot"
}}
```

### `GET /api/bot/campaigns/{id}/progress` — counts + percent
```jsonc
{ "success": true, "data": {
  "campaignId": "camp_...", "status": "running", "provider": "elevenlabs",
  "total": 117,
  "counts": { "pending": 77, "calling": 1, "completed": 38, "failed": 1 },
  "callsMade": 38, "percentComplete": 33
}}
```

### `GET /api/bot/campaigns/{id}/live-calls` — currently dialing
```jsonc
{ "success": true, "data": { "campaignId": "camp_...", "count": 1, "calls": [
  { "leadId": "DL-...", "bolnaCallId": "exec_...", "startedAt": "...",
    "dealerName": "Ramesh Traders", "shopName": "Ramesh Auto",
    "phone": "9876543210", "city": "Pune", "state": "Maharashtra" }
]}}
```

### `GET /api/bot/campaigns/{id}/qualified` — hot leads (intent ≥ 75)
Completed calls scoring ≥ the CRM's qualified threshold, highest first.
```jsonc
{ "success": true, "data": {
  "campaignId": "camp_...", "threshold": 75, "count": 12, "qualified": [
    { "leadId": "DL-...", "intentScore": 88, "callOutcome": "completed",
      "completedAt": "...", "dealerName": "...", "shopName": "...",
      "phone": "9876543210", "city": "...", "state": "..." }
]}}
```

### `POST /api/bot/campaigns/{id}/retry-failed` — re-dial failures
Bundles retryable failed leads into a **new** campaign and starts it (source untouched).
Excludes `no_phone` / `ineligible_active_lead`. `400` if the source is still running or has
no retryable failures.
→ `{ campaignId: "<new>", retryCount, status: "running", firstCallPlaced, firstCallError }`.

### `GET /api/bot/campaigns` — list
Query: `page` (default 1), `limit` (default 20, max 100), `provider`, `source=bot`
(only bot-created campaigns).
```jsonc
{ "success": true, "data": { "data": [
  { "id": "camp_...", "name": "June Dealers", "status": "running",
    "provider": "elevenlabs", "totalLeads": 117, "callsMade": 40,
    "completedLeads": 38, "failedLeads": 2, "startedAt": "...",
    "completedAt": null, "triggeredByName": "Discord Bot" }
], "page": 1, "pageSize": 20 }}
```

## 6. Typical bot flow

1. `/upload-leads` (attach Excel) → store the returned `campaignId`.
2. `/start-campaign` → dialing begins on ElevenLabs.
3. Poll `/progress` (or `/status`) for the embed; `/live-calls` for who's on a call now.
4. `/qualified` when done → the leads worth a human follow-up.
5. `/retry-failed` to re-dial no-answers/busy as a fresh campaign.

## 7. Notes & limits

- **No app-level rate limiting.** The dialer self-throttles (1 s spacing, provider
  circuit-breakers). Polling every few seconds is fine; avoid tight loops.
- **Idempotency:** call placement is guarded once-per-(lead, phone, day) in Redis.
- **Call results** flow into the CRM via the provider's webhook + a 1-min polling backstop;
  the bot reads outcomes through `/progress` and `/qualified` — it does not receive push
  callbacks (none are emitted today; can be added later if the bot needs real-time pushes).
- Mid-flight lead injection into a running campaign is **not** supported — upload creates a
  new campaign instead.

*Implemented 2026-06-19. Auth: `src/lib/bot/auth.ts`. Service user: `src/lib/bot/constants.ts`
+ `drizzle/E-170_discord_bot_service_user.sql`. Routes: `src/app/api/bot/**`.*
