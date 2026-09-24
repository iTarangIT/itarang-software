# Ecofy ⇄ iTarang CRM sync — integration contract

Ecofy (`sandbox-ecofy.itarang.com`) and the iTarang CRM (`sandbox.itarang.com`) keep **separate code and
separate databases**. They exchange signed JSON events over HTTPS. Neither system reads the other's
database. Recorded as `docs/CONFLICTS.md` #24.

```
Ecofy                                                     iTarang CRM
  Ecofy User pushes a Warm lead (or marks it Hot)
  → outbox → integration_deliveries ──POST (signed)──▶  /api/integrations/ecofy/events   (CRM builds this)
                                                          → upsert lead by ecofyCaseId
                                                          → Sales Head › "Ecofy Leads"
  POST /api/v1/integrations/itarang/events ◀──POST (signed)── Sales Head assigns / calls / returns / closes
  → runs the normal case services (gates, audit)
```

## 1. Shared settings

| Setting | Ecofy env | CRM side |
|---|---|---|
| CRM receive URL | `ITARANG_CRM_URL` | the route you expose, e.g. `https://sandbox.itarang.com/api/integrations/ecofy/events` |
| Shared secret (≥ 32 chars, one per environment) | `ITARANG_CRM_SECRET` | same value |
| Ecofy send URL | — | `https://sandbox-ecofy.itarang.com/api/v1/integrations/itarang/events` |
| Integration user | `ITARANG_CRM_ACTOR_EMAIL`: an **ACTIVE iTarang Admin** user in Ecofy (e.g. `crm-sync@itarang.com`) | — |

If the URL or secret is blank, Ecofy sends nothing. If the secret or actor is blank, the inbound endpoint answers 404.

## 2. Signing (both directions)

Every request carries:

```
Content-Type: application/json
X-Itarang-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
X-Itarang-Event-Id: <eventId>          (Ecofy → CRM only; informational)
```

The receiver computes the HMAC over the **raw body bytes** (before JSON parsing), compares it in constant
time, and rejects requests whose `t` is more than 300 seconds from its own clock. Node example:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
export function verify(secret: string, header: string | null, raw: string) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  const mac = createHmac("sha256", secret).update(`${m[1]}.${raw}`).digest("hex");
  return timingSafeEqual(Buffer.from(m[2], "hex"), Buffer.from(mac, "hex"));
}
export const sign = (secret: string, raw: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
```

## 3. Ecofy → CRM (the CRM must implement this endpoint)

`POST <ITARANG_CRM_URL>`. Answer **2xx** once the event is stored. Any other answer (or a timeout
after 10 s) is retried with back-off (10 s, 20 s, … capped at 1 h; 12 attempts, about 6 hours), then parked
as `DEAD`. Events of one lead arrive **in order**: a newer event waits until the older one is accepted.
Delivery is at-least-once, so **deduplicate on `eventId`**.

Reply to `lead.pushed` with `{ "crmLeadId": "<your id>" }` so Ecofy links the two records. You can also
send `lead.accepted` later.

### `lead.pushed`: a new lead for the Sales Head

Sent when an Ecofy user pushes a Warm lead, or marks a lead Hot (both move S0 → S1). If the lead was
returned and pushed again, it is sent again with the same `ecofyCaseId`, so **upsert by `ecofyCaseId`**.

```json
{
  "eventId": "ecofy:ECOFY:1234",
  "type": "lead.pushed",
  "occurredAt": "2026-09-24T10:15:00.000Z",
  "source": "ECOFY",
  "tenant": "ECOFY",
  "lead": {
    "ecofyCaseId": "7c1c…", "caseNo": "ECF-1042", "version": 4,
    "stage": "S1", "subStatus": null, "segment": "RESI", "temperature": "WARM",
    "source": "ECOFY_MANUAL", "owner": "ECOFY", "qualifiedByName": "Ecofy User One",
    "queueEnteredAt": "2026-09-24T10:15:00.000Z",
    "productInterest": "SOLAR_STORAGE", "avgMonthlyBillInr": 4500, "sanctionedLoadKw": 5,
    "existingBackup": null, "preferredCallTime": "after 5 pm", "closureReason": null,
    "customer": {
      "fullName": "…", "mobile": "+9198…", "altMobile": null, "email": null,
      "customerType": "INDIVIDUAL", "businessName": null,
      "address": "…", "city": "Pune", "state": "MH", "pincode": "411001",
      "preferredLanguage": "hi", "propertyType": "HOUSE"
    },
    "ecofyUrl": "https://sandbox-ecofy.itarang.com/cases/7c1c…",
    "crmLeadId": null
  }
}
```

`temperature` is `HOT` or `WARM`; show Hot first (FR-05.1). Financing amounts are never sent.

### `lead.stage_changed`: status updates for a lead already sent

Same envelope, plus the change. `lead` is the current snapshot. **Ignore a snapshot whose `lead.version`
is lower than the one you have.**

```json
{ "eventId": "ecofy:ECOFY:1260", "type": "lead.stage_changed", "occurredAt": "…", "source": "ECOFY", "tenant": "ECOFY",
  "change": { "from": "S1", "to": "S2", "subStatus": null, "reason": null },
  "lead": { "ecofyCaseId": "7c1c…", "version": 5, "stage": "S2", "…": "…" } }
```

`to` is `S0` when the lead went back to Ecofy (`reason` = return reason code), and `CLOSED` when it was closed
(`reason` = closure reason). Changes the CRM caused are echoed back too; treat them as confirmations.

## 4. CRM → Ecofy

`POST https://sandbox-ecofy.itarang.com/api/v1/integrations/itarang/events`, signed as in §2.

```json
{
  "eventId": "crm-9f2…",               // unique per event; a retry must reuse it
  "type": "lead.assigned",
  "occurredAt": "2026-09-24T11:00:00+05:30",
  "ecofyCaseId": "7c1c…",
  "crmLeadId": "L-5531",
  "actorName": "Priya Sharma (Sales Head)",
  "data": { … }
}
```

| `type` | `data` | Effect in Ecofy |
|---|---|---|
| `lead.accepted` | `{}` | Links `crmLeadId` to the case. |
| `lead.assigned` | `{ "assigneeName": "…", "reason"?: "…" }` | At S1: the case is assigned to the integration user and moves to **S2** (audit reason names the CRM person). Later: a REMARK. |
| `lead.activity` | `{ "type": "CALL"\|"REMARK"\|"COMMENT"\|"FOLLOW_UP", "callOutcome"?, "note"?, "nextFollowUpAt"? }` | Activity on the case, note prefixed `[iTarang CRM · actorName]`. `CALL` needs `callOutcome` (`CONNECTED`, `NO_ANSWER`, `BUSY`, `SWITCHED_OFF`, `WRONG_NUMBER`, `CALL_BACK`); `FOLLOW_UP` needs `nextFollowUpAt`. |
| `lead.returned` | `{ "reasonCode": "…", "note"?: "…" }` | Back to Ecofy (S1/S2 only, FR-05.3). Codes: `WRONG_NUMBER`, `NOT_INTERESTED`, `WANTS_LATER`, `DUPLICATE`, `OUT_OF_AREA`, `REQUALIFY`. |
| `lead.closed` | `{ "closureReason": "…", "note"?: "…" }` | Closes the case (S1–S4 only). Codes from Ecofy's `closure_reason` list, e.g. `NOT_INTERESTED`, `UNREACHABLE`. |

Replies use the Ecofy envelope:

| Status | Meaning | Retry? |
|---|---|---|
| 200 `{ data: { eventId, status: "APPLIED", case: { ecofyCaseId, caseNo, stage, version } } }` | Applied | no |
| 200 with header `X-Itarang-Duplicate: true` | Same `eventId` seen before; first answer replayed | no |
| 401 | Bad or expired signature | fix the signing |
| 409 `GATE_NOT_MET` (`gate`: `crm_lead` = the lead was never sent to the CRM; `stage` = not allowed at this stage) | Rejected and recorded | no, the same `eventId` gets the same answer |
| 422 `VALIDATION_FAILED` | Bad body / unknown code / `crmLeadId` differs from the linked one | no |
| 5xx / timeout | Not recorded | yes, with the same `eventId` |

## 5. Full API access: the CRM does anything the iTarang Admin does in Ecofy

Everything an iTarang Admin (or Caller) does in the Ecofy screens is a call to Ecofy's REST API
(`docs/ecofy_openapi_v1.0.1.yaml`, base `https://sandbox-ecofy.itarang.com/api/v1`). The CRM calls **the same
endpoints** server-to-server. It signs each request instead of logging in, and the call runs as a real Ecofy user of the
iTarang org. Examples: the queue, assign/reassign, calls and follow-ups, appointments, return to Ecofy, close/reopen,
assessment, eligibility, EPC quote requests, offers and OTP, the File, financing routing, installation, asset, documents,
reports, users, settings and lists. Each endpoint keeps its `x-roles`, gates, RLS, If-Match, Idempotency-Key and audit.

Headers on every call:

| Header | Value |
|---|---|
| `X-Itarang-Signature` | `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>." + signing string)>` |
| `X-Itarang-Act-As` | optional: email of an ACTIVE **iTarang Admin or Caller** in Ecofy. Default `ITARANG_CRM_ACTOR_EMAIL`. Ecofy-org users are refused (403). |
| `X-Itarang-Actor-Name` | optional: the CRM person. It is stored as the audit row's user agent, `itarang-crm (<name>)`. |
| `If-Match`, `Idempotency-Key`, `Content-Type: application/json` | exactly as the OpenAPI requires for that endpoint |

The **signing string** binds the signature to one request:

```
<METHOD> + "\n" + <path and query as sent, e.g. /api/v1/cases/7c1c…/assign> + "\n" + <raw JSON body, or "">
```

```ts
const raw = body === undefined ? "" : JSON.stringify(body);
const path = `/api/v1/cases/${id}/assign`;
const res = await fetch(`https://sandbox-ecofy.itarang.com${path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "if-match": String(version),
    "x-itarang-signature": sign(secret, `POST\n${path}\n${raw}`),   // sign() from §2
    "x-itarang-act-as": "ia@itarang.com",
    "x-itarang-actor-name": "Priya Sharma (Sales Head)",
  },
  body: raw || undefined,
});
```

Notes:
- Replies and errors are the normal Ecofy envelope (`{ data }` / `{ error: { code, gate?, … } }`).
- The one-live-session and trusted-device checks do not apply to signed calls. The `/auth/*` routes are refused.
- The act-as user sees what that user would see. An iTarang Admin also sees financing amounts whose row is marked
  visible to iTarang Admin (other financiers), exactly as in the Ecofy UI. Ecofy's own amounts stay hidden.
- Uploads work too: `…/upload-url` returns a pre-signed URL, and the CRM `PUT`s the file there without a signature.
- Keep the secret on the CRM server only. Never send it to a browser.

## 6. What the CRM team builds

1. `POST /api/integrations/ecofy/events`: verify the signature, dedupe on `eventId`, upsert `ecofy_leads`
   (or `leads` with `source = 'ECOFY'`, `external_id = ecofyCaseId`), answer `{ crmLeadId }`.
2. Sales Head › **Ecofy Leads** nav: list by `temperature` (Hot first) then `queueEnteredAt`; detail page
   with the customer, the stage and an "Open in Ecofy" link (`ecofyUrl`).
3. Either post the simple §4 events, or call the full API in §5 for anything the iTarang Admin does (screens for
   assessment, offers, OTP, financing, etc. can be built on the same endpoints the Ecofy UI uses).

## 7. Operations (Ecofy)

- Apply the tables once per database: `npm run db:migrate` (`db/schema/0001_itarang_crm_sync.sql`).
- Create the integration user in Ecofy (Admin › Users, role iTarang Admin), then set the three env vars and restart web + worker.
- Look at stuck deliveries: `select id, event_type, status, attempts, last_status, last_error from integration_deliveries where status <> 'SENT' order by id;`
- Re-send a parked one: `update integration_deliveries set status = 'PENDING', attempts = 0, next_attempt_at = now() where id = …;`
