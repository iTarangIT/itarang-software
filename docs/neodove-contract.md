# NeoDove integration contract

**Status: UNVERIFIED — fill this in against a live account before trusting the integration.**

Everything NeoDove-facing in `src/lib/neodove/` is written against the guesses recorded
here. NeoDove publishes an end-user manual at [docs.neodove.com](https://docs.neodove.com)
but **no developer reference, no OpenAPI spec, no auth documentation, no error codes and
no payload samples**. `apidoc.neodove.com` 404s, and there is **no NeoDove Zapier app**,
so there is not even a third-party action list to reverse-engineer a schema from.

The code is structured so that correcting these guesses is cheap: every assumption below
maps to exactly one function, named in its row.

> NeoDove is a **Vyapar** product (Simply Vyapar Apps, Bengaluru — acquired May/June
> 2022). It is *not* an Ozonetel product; Ozonetel's APIs are irrelevant here.

---

## What NeoDove can and cannot do

| Capability | Available | Mechanism |
|---|---|---|
| Push leads CRM → NeoDove | ✅ | Per-campaign **Custom Integration** endpoint. POST raw JSON. `mobile` mandatory; `name`/`mobile`/`email` reserved; other keys become custom fields. |
| Update an existing NeoDove lead | ⚠️ | A second `Endpoint(Update only)` URL is generated. **Matching semantics undocumented.** |
| NeoDove → CRM on disposition | ✅ | **Workflows → Send Webhook** — triggers on `lead created` / `call connected` / `call not connected`, filters by Campaign/Stage/Tag, supports custom headers and a custom body. Fallback: Integrations → Webhook (Lead Create / Lead Dispose / Lead Delete, fixed payload). |
| Pull leads / call reports / agent reports | ❌ | **No read API.** UI + CSV export only. |
| Create / manage campaigns via API | ❌ | NeoDove UI only. |
| Assign a lead to an agent from the CRM | ❌ | No assignee param exists — see §2 assumption 2b. Assignment is the campaign's **members + lead-distribution setting**, both NeoDove-UI-only. |
| Trigger a call from the CRM | ❌ | **No dial API, no call control, no agent API.** The nearest honest thing is the priority-dial push in §6. |
| Call recording delivered to the CRM | ❓ | UNCONFIRMED. Parsed if present (§4); depends on the account's telephony setup and on the Workflow body's variable list. |

Two facts drive the whole design:

1. **The endpoint URL is the credential.** NeoDove issues no API key, bearer token or
   signing secret; the campaign endpoint is a generated URL with an opaque token in it.
   Possession of the URL is write access. Hence `neodove_campaigns.push_endpoint_ref`
   stores the *name of an env var*, never the URL.
2. **There is no way to query NeoDove.** A dropped webhook is unrecoverable. That is why
   `neodove_sync_events` is a reconciliation ledger and why `/api/neodove/reconcile`
   exists at all.

---

## Phase 0 checklist

- [x] **Ask the CSM to enable Custom Integration.** Done — it was already enabled on the
      iTarang TECH account as of 2026-08-01.
- [ ] **Email the Custom Integration account manager to activate the subscription —
      ONCE PER INTEGRATION.**
      **This was recorded as "MOOT" on 2026-08-03 and that was WRONG.** The original
      integration (`4ea39130-…`) delivers because the CSM enabled it on 2026-08-01;
      what looked like "no gate exists" was really "the gate had already been opened
      for the one integration we had".
      **Proven 2026-08-11 by controlled experiment.** Three new Custom Integrations were
      created (`aeb5d3ff-…`, `1d2e0673-…`, `c7f30377-…`), each bound to a hand-made
      campaign. Identical probe payloads were POSTed to the old and a new integration,
      same host, same `/integration/custom/<id>/leads` path, same body. **Both returned
      `200 OK` with body `OK`. Only the OLD one created a lead.** The new campaign stayed
      on "Oops, no leads found!" through four real pushes plus the probe.
      ⇒ A newly created Custom Integration accepts and SILENTLY DISCARDS every lead until
      the account manager activates its subscription. There is no response, header, status
      code or log on our side that distinguishes this from success — `neodove_sync_events`
      records a clean `http_status=200`, `error=NULL` for a lead that does not exist.
      **This is the sharpest instance of §2's "a 200 proves nothing": budget for
      activation lead-time whenever a new campaign destination is added.**

- [x] **Can a Custom Integration bind to an EXISTING, hand-made campaign?** **YES**
      (2026-08-11). The wizard's destination step offers existing campaigns, not only
      "Create a new Campaign". This resolves the blocker recorded below about agent-less
      wizard-created campaigns: make the campaign by hand with its agents, then point a
      new Custom Integration at it.

- [x] **Endpoint path shape — `/integration` is REQUIRED.** Probed 2026-08-11:
      `https://<acct>.neodove.com/integration/custom/<id>/leads` → 200;
      `https://connect.neodove.com/integration/custom/<id>/leads` → 200;
      `https://<acct>.neodove.com/custom/<id>/leads` → **405 Not Allowed** (nginx).
      `NEODOVE_PUSH_ENDPOINT_TEST` had been hand-edited into that 405 shape and was dead;
      the 12 leads credited to it landed on 03-Aug, before the edit. Copy these URLs
      verbatim from NeoDove and never retype them — this is the second time a hand-edit
      has silently broken one (see the `?update=true` note in `.env.local`).
- [ ] **Ask, in writing, whether any enterprise read API exists.** If yes, most of the
      reconciliation path becomes unnecessary. Record the answer here.
- [ ] **Ask for the `lead_status` code table.** The inbound payload carries
      `"lead_status":"6"` — an opaque per-account numeric code with no published mapping.
      Until answered it resolves to no `CallStatus` (see §4).
- [ ] **Ask whether campaign membership can be set on a wizard-created campaign.** A
      campaign auto-created by the Custom Integration wizard has no agents, so every lead
      pushed into it shows an empty **Select Assignee** and nothing can be worked. NeoDove
      documents `Select Agents` only in the *create* wizard, never in Edit Campaign — so it
      may be unfixable after the fact, in which case the remedy is a hand-made campaign
      plus a second Custom Integration (new endpoint URL → new env var → repoint
      `push_endpoint_ref`). **This is the current blocker on the whole calling loop.**
- [ ] **Ask what the rate limits are.** Entirely undocumented. Until answered,
      `NEODOVE_PUSH_CONCURRENCY=5` / `NEODOVE_PUSH_DELAY_MS=250` are guesses.
- [ ] Create a Custom Integration on one **test** campaign and capture both URLs below.
- [x] ~~Point a request bin at Workflows → Send Webhook, trigger a real disposition, and
      paste the payload below.~~ **ANSWERED 2026-08-03 without a request bin** — the
      Integrations → Webhook screen prints an **"Example Url (Curl)"** block containing the
      literal body. See §4; it invalidated 7 of the parser's 9 field guesses.
- [ ] Probe `Endpoint(Update only)` semantics (below).
- [ ] Record whether a successful create returns a NeoDove lead id.

---

## 1. Endpoint URLs

NeoDove generates two per integration. Record only their **shape** here — the live values
belong in the environment, never in this file and never in the database.

**Confirmed 2026-08-01** by creating a Custom Integration on the iTarang TECH
account (Integrations → Custom Integration → Body Params → Create a new
Campaign → Pipeline "Sales"). Shape:

```
Endpoint (create):       https://<account-uuid>.neodove.com/integration/custom/<integration-uuid>/leads
Endpoint (update only):  https://<account-uuid>.neodove.com/integration/custom/<integration-uuid>/leads?update=true
Auth mechanism observed: ☑ token in path — TWO opaque UUIDs, one in the
                           SUBDOMAIN (per account) and one in the path (per
                           integration). No key, no header, no signature.
Method:                  POST
Headers:                 Content-Type: application/json   (that is all)
```

Note the update endpoint is **the same URL with `?update=true`**, not a
separately issued one — so both env vars hold near-identical strings and it is
easy to paste the wrong one. `resolveEndpoint()` cannot tell them apart; only
the `push_endpoint_ref` / `update_endpoint_ref` column names do.

The integration created here is `Platform: iTarang CRM`, campaign
`CUSTOM_INTEGRATION-campaign`, type `PUSH`. That campaign name is what belongs
in `neodove_campaigns.neodove_campaign_name`.

> **A SECOND ACTIVATION GATE EXISTS.** The Active Integrations page states:
> *"Please copy these details and send over to your Custom Integration account
> manager via email. Once they active subscription, lead will start comming to
> the campaign selected by you."* So enabling Custom Integration (the CSM step)
> only issues the URL — a further **subscription activation by the account
> manager** is what makes pushed leads actually land in the campaign. Until that
> is done, expect pushes to be accepted-but-dropped, or rejected, and do NOT read
> a silent 200 as success. Verify in NeoDove's UI that the lead appears.

Env vars to set (one pair per campaign):

```bash
NEODOVE_ENABLED=true
NEODOVE_PUSH_ENDPOINT_<CAMPAIGN_SLUG>=https://…      # the create URL
NEODOVE_UPDATE_ENDPOINT_<CAMPAIGN_SLUG>=https://…    # the update-only URL
NEODOVE_WEBHOOK_SECRET=<generate a long random string>
# Optional tuning
NEODOVE_PUSH_CONCURRENCY=5
NEODOVE_PUSH_DELAY_MS=250
NEODOVE_TIMEOUT_MS=15000
```

Then set `neodove_campaigns.push_endpoint_ref` to the **variable name**
(e.g. `NEODOVE_PUSH_ENDPOINT_DEALER_Q3`), not the URL.
→ Resolved by `resolveEndpoint()` in `src/lib/neodove/config.ts`.

### Adding a campaign — the whole runbook

Adding a destination is an **env change plus a DB row**, never a code change.
That is the point of the ref indirection. Per campaign:

1. **NeoDove → Pipeline → Create Campaign.** Note the campaign name *exactly*.
2. **Integrations → Custom Integration** for that campaign. Copy the endpoint
   URL and its `?update=true` variant.
3. Add `NEODOVE_PUSH_ENDPOINT_<SLUG>` and `NEODOVE_UPDATE_ENDPOINT_<SLUG>` to
   `.env.local` and to the VPS environment, then **restart PM2**. `process.env`
   is read per request, but the process still has to be restarted to see a new
   value. `GET /api/neodove/endpoints` then lists the new name, and the campaign
   form's endpoint picker offers it.
4. **CRM → Leads → NeoDove Campaigns → New campaign.** Set the CRM name, the
   NeoDove campaign name, and pick the endpoint from the dropdown.
   > ⚠ The NeoDove campaign name must match **exactly**. Inbound webhooks are
   > resolved by string-matching it against `campaign_name`
   > (`src/lib/neodove/inbound.ts`), so a typo costs you the campaign's
   > disposition counters and its lead links.
5. **NeoDove → Workflows → Send Webhook**, for the new campaign, pointing at
   `/api/neodove/webhook` with the `Authorization: Bearer <NEODOVE_WEBHOOK_SECRET>`
   header. **This is the step that gets forgotten.** Without it the campaign
   pushes fine and nothing ever comes back — which looks exactly like the
   disposition filter being broken.
6. Push **one** test lead and confirm it appears in the intended campaign in
   NeoDove. See the activation-gate warning above: a 200 is not proof.

**Two campaigns must never share a `push_endpoint_ref`.** The push body carries
no campaign identifier — `dealerLeadToNeodove()` sends `mobile`, `name` and the
`itarang_*` custom fields, nothing else — so **the URL is the routing**. Two CRM
campaigns pointing at one endpoint deliver into the same NeoDove campaign, and
the destination dropdown then offers a choice that changes nothing. This is not
hypothetical: it is how three demo campaigns all ended up in
`CUSTOM_INTEGRATION-campaign`. Both the campaigns list and the Send-to-NeoDove
modal now flag a shared endpoint.

**"Wired" means the variable resolves, not that a ref was typed.** `is_wired`
used to be `push_endpoint_ref IS NOT NULL` in SQL, so a campaign referencing a
variable nobody had set was offered as a valid destination and failed at push
time, far from the mistake. It is now computed with `isEndpointWired()` — the
same `resolveEndpoint()` the push path calls — in both the list and detail
routes, and the campaign detail page distinguishes *nothing configured* from
*configured but the variable is missing on this server*.

---

## 2. Outbound payload — what we send

Currently produced by `dealerLeadToNeodove()` in `src/lib/neodove/mapper.ts`:

```json
{
  "mobile": "9876543210",
  "name": "Ramesh Kumar",
  "itarang_lead_id": "DL-1234567890-abcd1234",
  "itarang_shop_name": "Sharada Enterprises",
  "itarang_city": "Ujjain",
  "itarang_state": "Madhya Pradesh",
  "itarang_source": "manual_upload_lead"
}
```

**Assumptions to verify:**

| # | Assumption | Where to fix |
|---|---|---|
| 1 | `mobile` is sent as the bare 10-digit national number, **without** `+91`. Confirmed against NeoDove's own sample body, which shows `9509624540`. | `dealerLeadToNeodove()` |
| 1b | We send `mobile` as a JSON **string**; NeoDove's sample shows it **unquoted, as a number** (`"mobile": 9509624540`). Most parsers accept either, and a numeric type would silently drop any leading zero, so string is the safer choice — but if pushes are rejected with a type/validation error, this is the first line to try changing. | `dealerLeadToNeodove()` |
| 2 | Unknown keys are accepted and stored as custom fields rather than rejected. | — |
| 2b | **There is no assignee/agent/owner param — confirmed 2026-08-03.** The wizard's "Body Params" is only a radio choosing body-vs-query, not a field declaration, and its own sample body is `{"name", "mobile", "email", "detail1", "detail2"}` — three reserved fields plus arbitrary custom keys. Sending `assignee` would create a custom field, not assign the lead. **A pushed lead therefore arrives unassigned, and no change on our side can alter that.** Assignment happens only inside NeoDove: agents must be members of the campaign, and the campaign's own lead-distribution setting is what hands arriving leads to them. A campaign auto-created by the Custom Integration wizard has NO members — hence an empty "Select Assignee" dropdown on every pushed lead until someone staffs it in their UI. This is what `mirror_config.agents` / `.leadDistribution` (E-225) describe, and the reason they are descriptive: they record a NeoDove-side configuration we cannot write. | not fixable in `dealerLeadToNeodove()` |
| 3 | Custom fields survive and are echoed back on webhooks (this is what makes `itarang_lead_id` a usable join key). | `resolveInboundLead()` in `inbound.ts` |

Actual response to a create, captured 2026-08-01:

```
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
Content-Length: 2

OK
```

**A 200 FROM THIS ENDPOINT PROVES NOTHING.** The probe that produced the response
above sent `"mobile": "<YOUR-10-DIGIT-MOBILE>"` — the literal placeholder string,
not a phone number — and NeoDove *still* answered `200 OK`. `mobile` is documented
as the only mandatory field, so this endpoint performs **no validation at the HTTP
layer at all**: it acknowledges receipt of bytes and nothing more. Whether a lead
was created, silently dropped, or rejected downstream is invisible from the
response.

Consequences, all of them load-bearing:

1. `pushLead()` sets `ok: res.ok` (`client.ts:84`). That flag therefore means
   **"accepted"**, never "created". `neodove_lead_links.push_status = 'pushed'`
   and the `total_pushed` counter inherit the same weakness — they count
   *attempts NeoDove did not refuse*, not leads that exist in NeoDove.
2. Nothing in the outbound path can be self-verifying. This is the concrete
   reason `/api/neodove/reconcile` and the CSV diff are load-bearing rather than
   polish: a NeoDove CSV export is the **only** evidence a push landed.
3. There is no lead id to capture. The body is the two bytes `OK` with
   `Content-Type: text/plain`, so `extractLeadId()` returns null on every push and
   `neodove_lead_links.neodove_lead_id` will always be NULL in practice. Inbound
   matching therefore rests entirely on normalised phone plus whatever
   `itarang_*` fields NeoDove echoes back — i.e. assumption #3 below is now
   **critical path**, not a nice-to-have.
4. `JSON.parse("OK")` throws, so `client.ts` falls back to storing the raw text.
   That path works as designed — it lands in `response_payload` as the jsonb
   string `"OK"`.

→ `extractLeadId()` in `src/lib/neodove/client.ts` probes `lead_id` / `leadId` /
`id` / `uuid` / `unique_id`. Against the `OK` body above it returns null every
time. **Leave it in place** — it costs nothing, and it is what would pick the id
up automatically if NeoDove ever starts returning one (or if the update-only
endpoint answers differently). Just do not build anything that depends on
`neodove_lead_id` being populated.

---

## 3. Update-only endpoint semantics

**Partly answered 2026-08-01:** the update endpoint is not a separate URL at all — it is
the create URL plus `?update=true`. That means the *routing* is a flag on one endpoint,
and whatever matching NeoDove does must be inferred from the body. `mobile` is the only
mandatory field, so it is almost certainly the match key — but "almost certainly" is not
good enough to write records on, so still probe:

- [ ] Push the same `mobile` twice to the **create** endpoint → does it create a duplicate,
      update, or error? Result: ______
- [ ] POST to the **update-only** endpoint with a `mobile` that exists → what matches?
      Result: ______
- [ ] POST to update-only with a `mobile` that does **not** exist → create, 404, or silent
      no-op? Result: ______

Until answered, `updateLead()` in `client.ts` simply delegates to `pushLead()` and callers
must not treat success as a guarantee that anything was updated.

---

## 4. Inbound webhook payload — the big unknown

Configure in NeoDove: **Workflows → Send Webhook**, method POST, and a custom header:

```
Authorization: Bearer <NEODOVE_WEBHOOK_SECRET>
```

Point it at `https://<host>/api/neodove/webhook`.

> ~~Prefer Workflows over Integrations → Webhook: only Workflows supports custom headers,
> and without a header there is no way to authenticate the sender at all.~~
>
> **CORRECTED 2026-08-03.** Integrations → Webhook **does** support custom headers — the
> screen has two key/value rows, and `Authorization: Bearer <secret>` works there. Choose
> between the two on payload, not on auth:
>
> | | Integrations → Webhook | Workflows → Send Webhook |
> |---|---|---|
> | Triggers | Lead Create, Lead Dispose | lead created, call connected, call not connected |
> | Filtering | none | by Campaign / Stage / Tag |
> | Body | **FIXED** (see §4) | author-defined |
> | Custom headers | ✅ | ✅ |
>
> The fixed body is the deciding factor: it carries **no agent name and no recording URL**,
> so E-226's `external_agent_name` / `recording_url` can only ever be populated via
> Workflows, where the body is ours to define. Use Integrations → Webhook to get the loop
> working; move to Workflows when call evidence matters.

### How to capture it

No tooling or DB session is needed — the webhook route persists the raw body
**verbatim** into `neodove_sync_events.request_payload` *before* it parses
anything, so even a completely unrecognised payload is captured
(`src/app/api/neodove/webhook/route.ts`).

1. Expose localhost: `cloudflared tunnel --url http://localhost:3000`
   (project precedent — **not** ngrok 3.3.1; the URL changes on every restart,
   so it must be re-registered in NeoDove each session).
2. Sanity-check reachability by opening `<tunnel>/api/neodove/webhook` in a
   browser — the `GET` handler answers `{ ok: true, service: "neodove-webhook" }`
   for exactly this purpose.
3. Register it in NeoDove as above, then disposition one real lead.
4. Open **Leads → NeoDove → Sync Activity**, filter to `Received`, and click
   **View** on the newest row. That is NeoDove's exact body.

> The same screen strips the `endpoint` key from *outbound* rows before it
> leaves the server. `redactEndpoint()` keeps the origin, and the origin is
> `https://<account-uuid>.neodove.com` — half the credential. Redacted enough
> for a server log is not the same as safe to hand to a browser.

### ✅ ANSWERED 2026-08-03 — the fixed payload, from NeoDove's own sample curl

No request bin was needed in the end. The **Integrations → Webhook** screen renders an
**"Example Url (Curl)"** block once a URL and headers are filled in, and it contains the
literal body NeoDove will POST:

```json
{
  "name": "Neodove",
  "mobile": "9509624540",
  "lead_id": "ae8ef37e-c0cd-4e69-b150-55a29b090065",
  "campaign_id": "be8ef37e-c0cd-4e69-b150-55a29b090065",
  "lead_status": "6",
  "call_connected": "false",
  "lead_stage_name": "Open",
  "time": "1638806214940",
  "event_name": "LEAD_DISPOSE"
}
```

Headers: `Content-Type: application/json` plus whatever you add. Method POST.

The **values** are NeoDove's placeholders (that mobile is the same one their Custom
Integration sample uses); the **keys** are authoritative for this trigger. Pinned as
`REAL_DISPOSE_PAYLOAD` in `src/lib/neodove/__tests__/mapper.test.ts` — change the parser
and those tests tell you what you broke.

**Seven of the nine keys `parseInboundEvent()` looked for were absent.** The table below
was the guess; the right-hand column is what actually arrived.

| # | What we guessed | What NeoDove really sends | Was the consequence |
|---|---|---|---|
| 1 | `event` / `event_type` / `eventType` / `trigger` | **`event_name`** (`LEAD_DISPOSE` / `LEAD_CREATE`) | ✗ Every event fell through to the `lead_disposed` default, so a **LEAD_CREATE was routed to `handleLeadDisposed`**, matched no local phone and landed `unresolved`. The inbound-create half of the two-way sync was dead, silently. **Worst of the seven.** |
| 2 | stable id in `event_id` / `eventId` / `id` / `unique_id` / `uuid` | **nothing** — no per-event id exists | ✗ Synthetic key is the NORMAL path here, not the fallback. `id` was also *removed* from the candidate list: NeoDove has no `id`, but a provider whose `id` meant the LEAD id would collapse every event for that lead into one. |
| 3 | `mobile` / `phone` / `mobile_number` / `contact_number` | **`mobile`** | ✓ correct |
| 4 | disposition in `disposition` / `call_disposition` / `status` | **no disposition text at all** — only `call_connected` ("true"/"false") and `lead_status`, an opaque numeric code | ✗ Touchpoints got no call status. Now derived from `call_connected`; `lead_status` is carried verbatim and deliberately left unresolved. |
| 5 | flat, or nested under `data` / `lead` / `payload` | **flat** | ✓ correct |
| 6 | recording URL under any of 8 keys | **absent from this trigger** | ✗ Not a parsing bug — the fixed body structurally cannot carry it. See the Workflows table in §4's note. |
| — | timestamp in `timestamp` / `created_at` / `event_time` / `call_time` | **`time`**, epoch **millis as a string** | ✗ `new Date("1638806214940")` is Invalid Date → `occurredAt` was always null → dedupe degraded to a 60-second bucket, so a genuine second call to the same lead inside one minute was dropped as a replay. `asDate()` now handles 10- and 13-digit epochs. |
| — | campaign in `campaign` / `campaign_name` / `campaignName` | **`campaign_id`** (UUID), no name anywhere | ✗ Every name-based campaign lookup was unreachable — including the `dispositions_received` counter's `WHERE neodove_campaign_name = …`, which is why it read 0 against real dispositions. Both campaign reads are now derived from `neodove_lead_links` instead. |
| — | agent in `agent` / `agent_name` / `user` | **absent from this trigger** | ✗ Same as #6. |

**Still open:** `lead_status` is a numeric code (`"6"`) with no published lookup table. Ask
NeoDove for the mapping; until then it is stored as free text and resolves to no
`CallStatus`, which is honest. `lead_stage_name` ("Open") is the human-readable field and
is deliberately **not** in `STAGE_TO_LEAD_STATUS` — it is NeoDove's untouched-lead stage
and must not move our lead status.

**Remaining assumption, unchanged:**

| # | Assumption | Consequence if wrong |
|---|---|---|
| 6 | A recording URL, if one exists at all, is in one of `recording_url` / `recordingUrl` / `recording` / `call_recording` / `callRecording` / `recording_link` / `audio_url` / `audioUrl`, and is an absolute `http(s)` URL. Anything else is discarded rather than rendered (E-226). | `lead_touchpoints.recording_url` stays NULL and the lead timeline shows no player. |

**Capture the Workflow variable list at the same time.** The custom-body builder in
Workflows → Send Webhook has a placeholder/variable picker. Screenshot it. It answers
three questions at once that nothing else can: whether a **recording URL** is available,
whether a **stable event id** is (assumption #2 — verify this one first), and what the
**agent** field is actually called. `external_agent_name` and `recording_url` (E-226)
exist to hold the first and third; both stay NULL until this is done.

> **Recording caveat, independent of the payload.** NeoDove's app-based recording runs
> into Android 10+'s block on third-party call recording. If recordings turn out to be
> patchy or absent per-device, that is the reason, and no webhook field will fix it —
> reliable recordings need cloud telephony (the **Cloud Telephony** item in NeoDove's
> sidebar names whichever provider the account is on).

**The account's disposition vocabulary — CAPTURED (E-236).** It arrived as the
CC team's "Lead Dispositions" sheet and now lives in
`src/lib/leads/dispositions.ts`. It is a three-level tree, and it matched almost
none of the factory defaults `DISPOSITION_TO_CALL_STATUS` was guessing at:

```
L1 Connected
   L2 Cold       Loan Procedure Issue · Service Issue · As to Call Back ·
                 Need Some Time · No requirement in current ·
                 Bad Experience with Trontek · Short Hang up
   L2 Warm       Details Shared · Information Collected · Meeting Scheduled ·
                 Commercials Explained · Price High
   L2 Hot        Quotation Sent · Commercials Explained · Under Negotiation ·
                 Documents Recieved · Commercials Finalised
   L2 Converted  Deal Closed · Order Received · Full Payment Received · Onboarding Done
   L2 Lost       Not Interested · Lost to Competition · Some other Business ·
                 Business Closed · REJECTED BY US

L1 Not Connected  (no L2 — these ARE the disposition the agent taps)
   Did not pick · Busy in another call · User disconnected the call · Switch off ·
   Out of Coverage area / Network issue · Call not connected / can not be completed ·
   Other reason · Incorrect / Invalid number · Incoming calls not available ·
   Number not in use / does not exist / out of service
```

**Where it arrives in the payload: `lead_tag_name`, not `lead_status_name`.**
That is what NeoDove's own "Leads by tags" chart renders. `dispositionFor()`
therefore reads `tag` first, then `disposition`, then an exact match on
`dispose_remarks`. Reading `lead_status_name` first would classify nearly every
real call as unmapped, because that field carried generic values ("Open") in the
captured payload.

`disposition → our CallStatus`, now derived from the sheet rather than guessed:

| Disposition | `CallStatus` |
|---|---|
| every **Connected** L3 (all 26) | `connected` |
| Did not pick, Busy in another call, User disconnected the call, Call not connected / can not be completed, Other reason | `not_responding` |
| Switch off, Out of Coverage area / Network issue, Number not in use / does not exist / out of service | `not_reachable` |
| Incorrect / Invalid number | `incorrect_number` |
| Incoming calls not available | `no_incoming` |

> **"Short Hang up" is Connected**, per the sheet, and is mapped that way. A
> hang-up after one second is still a connected call; filing it under
> `not_responding` would understate the connect rate.

> **"Commercials Explained" is listed under both Warm and Hot.** That is the
> source data, not a transcription slip, and it is the one place the taxonomy is
> not a tree. `lead_stage_name` settles it when it disambiguates; otherwise the
> sheet's first occurrence wins, which is **Warm**. So a Hot bucket filter
> under-counts it — chosen over the alternative, where Warm and Hot would both
> count it and their totals would exceed the row count.

**`DISPOSITION_TO_CALL_STATUS` is now the fallback, not the primary.** It still
covers NeoDove's stock vocabulary, so a second campaign configured with the
factory list still gets a `call_status` instead of null.

**The disposition is now persisted, not just summarised into `remarks`** (E-236):
`lead_touchpoints.disposition` / `.disposition_bucket` / `.connect_status`
per call, plus `dealer_leads.last_disposition*` denormalised for the `/leads`
filter. `external_stage` / `external_tag` keep NeoDove's own words verbatim, so
the next vocabulary change is diagnosable without re-reading raw payloads.

And the stage list, for `STAGE_TO_LEAD_STATUS` — still **deliberately empty of
the account's values**:

```
stage → our LeadStatus
Cold          → (none — recorded as a disposition bucket, not a pipeline stage)
IN-PROGRESS   → (none)
Lost          → (none — see the note below)
Converted     → (none — see the note below)
```

The account's stages are coarser than our pipeline (they collapse Warm and Hot
into one "IN-PROGRESS") and the disposition carries strictly more information,
so nothing was added here. A disposition **never moves `lead_status`** — it is
stored, filterable and visible on the lead, and a human still decides Converted
and Lost. See the note immediately below for why that is not a temporary state.

> Note: `Lost` and `Converted` are deliberately **absent** from the stage map. Our `Lost`
> transition requires a `lost_reason` from a fixed vocabulary NeoDove has no equivalent
> for, and `Converted` means a real onboarding record exists, which a telecaller ticking a
> dropdown cannot create. Both surface to a human instead. Don't add them without
> deciding what a wrong one costs.

---

## 5. Verification once wired

1. Create a campaign in the CRM, push ~5 test leads → confirm all 5 appear in NeoDove
   **with custom fields intact**.
2. Dispose one in NeoDove → confirm a `lead_touchpoints` row lands with
   `external_system='neodove'`, `sync_method='api'`, and `dealer_leads.last_touchpoint_at`
   updated.
3. **Replay the captured webhook body twice** → confirm exactly one touchpoint row.
4. Send with a wrong/missing `Authorization` header → 401, nothing written.
5. Create a lead **in NeoDove** whose phone already exists here → confirm `duplicate_skip`
   plus a link row, not a second lead.
6. Same, where the CRM lead is `Lost` → confirm `reactivateLead()` fires.
7. Same, with a different city → confirm a `duplicate_merge_requests` row.
8. Stop the server mid-disposition, export NeoDove's CSV, POST it to
   `/api/neodove/reconcile` → confirm the missing touchpoint lands with
   `sync_method='reconciliation'` and campaign drift returns to 0.
9. From **Leads**, tick a few rows → **Send N to NeoDove** → confirm the reported
   `queued` count matches what lands in NeoDove, and that re-sending the same
   selection reports `alreadyLinked` and does **not** move `total_pushed`.
   (Dedupe is the unique index on `(dealer_lead_id, neodove_campaign_id)`, so it
   holds across the single, batch and audience push paths alike.)
10. Confirm a disposed lead's row now renders in the **Activity timeline** on
    `/leads/<id>` — before this existed, touchpoints landed correctly and were
    invisible, which is indistinguishable from the integration being broken.

---

## 6. Single dialling, assignment and the priority-dial campaign (E-226)

Three requirements land here, and only one of them is ours to implement.

### Assignment — NeoDove-side, entirely

Confirmed 2026-08-03 (§2, assumption 2b): the Custom Integration endpoint has **no
assignee, agent or owner parameter**. A key called `assignee` would become a custom field,
not an assignment. A pushed lead therefore arrives **unassigned**, and no change on our
side can alter that. Two things decide who works it, both NeoDove-UI-only:

1. **Campaign members.** A campaign auto-created by the Custom Integration wizard has
   **none** — which is exactly why "Select Assignee" is empty on every pushed lead.
2. **Lead distribution** on that campaign: *On Demand* (leads sit unassigned until an
   agent clicks Start Calling) vs *Equal distribution* (split across members up front).

With an ORG_ADMIN login: Settings → Users (telecallers exist, EXECUTIVE role) → open the
campaign → Edit → add agents + managing user → set distribution. Prefer creating the
campaign **first** and then its Custom Integration, rather than keeping the wizard's
`CUSTOM_INTEGRATION-campaign` leftover.

If **Workflow → Add Workflow** offers an *Assign lead / Change owner* action on this plan,
that is the only lever the CRM has on assignment, and it is indirect: we already push
`itarang_city` / `itarang_state` / `itarang_source`, so a NeoDove workflow can route on
them. **Record here whether that action exists:** ______

Whatever is configured should be copied into the campaign's `mirror_config` (E-225) so it
is visible without opening NeoDove. That mirror is descriptive and changes nothing.

### Single dialling — a push, never a dial

NeoDove exposes no dial API, no call control and no agent API. `POST
/api/neodove/leads/[id]/dial` therefore does **not** dial: it pushes that one lead into the
campaign flagged `is_priority_dial`, whose NeoDove-side distribution is what puts it in
front of an agent. Every string in the route and the "Call now" modal says *requested* or
*queued*, never *calling* — an operator who reads "calling…" and hears silence concludes
the integration is broken.

Setup: tick **Priority dial destination** on one campaign (Campaign settings). At most one
campaign can hold it, enforced by a partial unique index; the API clears the incumbent
first, so ticking it elsewhere moves the flag. For the flag to mean anything, that campaign
must have members and a distribution that hands arriving leads straight to them.

The dial writes a `neodove_dial_request` touchpoint — deliberately not
`inside_sales_call` (nobody has spoken to anyone; counting it would inflate every call
volume and connect rate in BRD §0.11) and not `ai_dialer_admin_push` (that is the robot
dialler, and the AI-vs-human split depends on the two staying distinct). The real call
lands later as a separate touchpoint when the webhook reports the disposition; the two
rows side by side are what shows whether a priority dial was ever worked.

### If genuine CRM-initiated dialling is ever needed

It has to come from the telephony provider underneath NeoDove, not from NeoDove. Those
providers (the class NeoDove's **Cloud Telephony** page connects to) have click-to-call
APIs, call-status webhooks and recording URLs. `lead_touchpoints.recording_url` and
`external_agent_name` are deliberately NOT NeoDove-specific columns for that reason — a
telephony adapter would write the same two fields.

---

## 7. Operational notes

- **Plan cap.** The account showed 24,579 of 50,000 lead slots remaining. A bulk push
  consumes them; `neodove_campaigns.total_pushed` is the running count.
- **Integration logs** in NeoDove retain ~30 days — useful for cross-checking our ledger,
  but do not rely on them as an archive.
- **Deploy.** Sandbox and prod are Hostinger VPS + PM2, so `/api/neodove/webhook` needs a
  publicly reachable HTTPS path. Local testing needs a tunnel — this project uses
  `cloudflared`, not ngrok.
- **Bearer-token limits.** A static shared secret authenticates the sender, not the
  message: anyone holding it can forge any body, and it carries no replay protection.
  Replay is covered separately by the two partial unique indexes (`neodove_sync_events`
  and E-113's `lead_touchpoints_external_uniq`). Body integrity is **not** covered and
  cannot be until NeoDove ships real signing.

---

## Sources

- [docs.neodove.com](https://docs.neodove.com/llms.txt) — index
- [Custom Integration](https://docs.neodove.com/admin-portal/integrations/custom-integration)
- [Webhook](https://docs.neodove.com/admin-portal/integrations/webhook)
- [Workflows → Send Webhook](https://docs.neodove.com/admin-portal/workflows/workflow-send-webhook-functionality)
- [Reports FAQs](https://docs.neodove.com/admin-portal/reports/faqs) — confirms export-only
- [Vyapar acquisition](https://www.crunchbase.com/acquisition/vyapar-app-acquires-neodove--e43869db)
