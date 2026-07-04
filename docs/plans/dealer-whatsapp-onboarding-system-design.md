# Dealer Onboarding over WhatsApp — System Design (v1)

**Status:** Design / for implementation
**Owner:** iTarang Engineering
**Supersedes:** `dealer-whatsapp-onboarding-architecture.md` (business note) — folds in all of its §1–§13.
**One-line:** WhatsApp is the *collection channel*; the Sales Admin panel remains the *approval authority*.

## 0. Design principles (carried from the business note)
1. **WhatsApp collects; humans decide.** The system never silently approves a dealer — it prepares the
   application and lets Sales Admin review faster (§6, §9).
2. **No failed check passes silently.** A failed GST / PAN / bank check either asks the dealer to correct,
   or reaches Sales Admin with a **clear warning** (§8).
3. **Reuse, don't fork.** WhatsApp writes into the *existing* dealer-onboarding tables and the *existing*
   Sales Admin review list — not a separate queue (§12.5, §13).
4. **Provider-agnostic.** All WhatsApp I/O goes through one internal adapter; Interakt today, Meta Cloud
   API or Gupshup tomorrow, with no flow rewrite (§12.1).
5. **Agentic corrections.** The bot asks for missing/incorrect values, accepts corrected text or
   replacement docs, re-checks, and updates the draft — WhatsApp-first (§12.3).

---

## 1. High-level architecture

```text
                         ┌──────────────────────────────────────────────────────────┐
                         │                    DEALER (WhatsApp)                       │
                         │     "Hi" · sends GST.pdf · photo · "CONFIRM" / "CHANGE"     │
                         └───────────────┬───────────────────────────▲───────────────┘
                                         │ inbound msg + media        │ outbound replies
                                         ▼                            │ (template / session text)
        ┌────────────────────────────────────────────────────────────┴───────────────┐
        │                       WHATSAPP ADAPTER  (provider-agnostic)                  │
        │   Interakt (primary) · Meta Cloud API (future) · Gupshup (fallback)          │
        │   verifyInbound() · downloadMedia() · sendText() · sendTemplate() ·          │
        │   sendInteractive() · normalizeEvent() → canonical InboundEvent              │
        └───────────────┬──────────────────────────────────────────────▲──────────────┘
                        │ 200 fast-ack + enqueue                         │ send()
                        ▼                                                │
  POST /api/whatsapp/webhook ─── HMAC verify ─── dedupe(provider_msg_id) │
                        │ QStash publishToPath("/api/whatsapp/process")  │
                        ▼                                                │
        ┌──────────────────────────────────────────────────────────────┴──────────────┐
        │                 CONVERSATION ORCHESTRATOR  (agentic turn)                     │
        │  load session → state machine → decide next action → reply                    │
        │  states: GREETING → COLLECTING_DOC[n] → ASK_FIELD → SUMMARY →                 │
        │          AWAIT_CONFIRM → SUBMITTED / INCOMPLETE / CORRECTION                  │
        └───┬───────────────┬────────────────┬───────────────┬─────────────────────────┘
            │ SAVE          │ READ           │ CHECK         │ FILL
            ▼               ▼                ▼               ▼
   ┌────────────────┐ ┌──────────────┐ ┌──────────────┐ ┌───────────────────────────┐
   │ Document Store │ │ Extraction   │ │ Verification │ │ Application Filler         │
   │ Supabase       │ │ Gemini Flash │ │ Decentro     │ │ writes dealerOnboarding*   │
   │ bucket         │ │ (vision LLM) │ │ GST/PAN/Bank │ │ via /dealer-onboarding/save│
   │ dealer-        │ │ OCR fallback │ │ /Udyam/cheque│ │ + warnings + confidence    │
   │ documents      │ │              │ │              │ │                            │
   └────────────────┘ └──────────────┘ └──────────────┘ └─────────────┬──────────────┘
                                                                       │ on dealer CONFIRM
                                                                       ▼
                                            ┌──────────────────────────────────────────┐
                                            │ SALES ADMIN REVIEW PANEL  (existing)       │
                                            │ list (filter: source=whatsapp) → detail →  │
                                            │ Approve · Reject · Ask Correction          │
                                            └───────────────┬────────────────────────────┘
                                                            │ Ask Correction
                                                            ▼  notify dealer on WhatsApp (loop back)
```

**Layering rule (from §13):** the WhatsApp layer only does *conversation, collection, extraction,
verification, confirmation, handoff*. The business decision stays in the normal Sales Admin flow.

---

## 2. Component responsibilities

| # | Component | Responsibility | Reuses |
|---|-----------|----------------|--------|
| C1 | **WhatsApp Adapter** | Normalize provider quirks behind one interface; verify inbound, download media, send text/template/interactive | New (`src/lib/whatsapp/`); Gupshup logic from `src/lib/gupshup.ts` |
| C2 | **Webhook ingress** | Fast-ack (≤5s), HMAC verify, idempotency dedupe, enqueue | Razorpay webhook pattern + QStash `publishToPath()` |
| C3 | **Conversation Orchestrator** | Agentic state machine; one "turn" per inbound; decide next prompt | New (`src/lib/whatsapp/orchestrator.ts`) |
| C4 | **Document Store (SAVE)** | Persist original media untouched | Supabase `dealer-documents` bucket; `/api/uploads/dealer-documents` |
| C5 | **Extraction (READ)** | Read fields from any doc incl. legal | Gemini Flash; `parser.ts` extraction pattern; OCR fallback `src/lib/ocr` |
| C6 | **Verification (CHECK)** | Validate GST/PAN/Udyam/bank/cheque | `src/lib/decentro.ts` (`validateDocument`, `verifyBankAccount`) |
| C7 | **Application Filler (FILL)** | Write confirmed fields + warnings into draft | `dealerOnboardingApplications` / `dealerOnboardingDocuments` via `/dealer-onboarding/save` |
| C8 | **Confirmation engine** | Masked summary; understand CONFIRM/CHANGE incl. natural/Hinglish replies | New; intent parse via Gemini Flash |
| C9 | **Admin handoff** | Mark application submitted; alert Sales Admin; appears in normal list | Existing review panel + alert |
| C10 | **Correction loop** | Admin "Ask Correction" → notify dealer → collect → re-check | New notify route + orchestrator re-entry |

---

## 3. Dealer experience flow (from §3, made concrete)

```text
Dealer: "Hi" / "Start onboarding"
   ↓  (GREETING)
Bot: "Welcome to iTarang dealer onboarding. We'll collect your documents here."
   ↓  open/create whatsapp_onboarding_session + draft application row
Bot asks ONE document at a time (COLLECTING_DOC):
   "Please send your GST certificate."
   ↓
Dealer sends photo / PDF
   ↓  SAVE original → READ (Gemini) → is it the right doc & legible?
   ├─ unclear  → "This document is not clear. Please resend a clearer photo or PDF."
   ├─ wrong    → "This doesn't look like a GST certificate. Please send your GST certificate."
   └─ OK       → CHECK (Decentro) → store extracted_data + verification result → next document
   ↓  (after all required docs for the detected dealer type)
Bot may ASK_FIELD for things not in documents:
   owner name, mobile, email, company type, address confirmation, branch, finance? signatories
   ↓  (SUMMARY)
Bot sends MASKED summary of all details
   ↓  (AWAIT_CONFIRM)
Dealer replies:
   CONFIRM / OK / YES / HAAN        → submit to Sales Admin
   CHANGE / EDIT / WRONG / CORRECT  → correction flow, then summary again
   ↓
Application → Sales Admin review (existing panel)
```

---

## 4. Conversation state machine

```text
            ┌─────────┐  "hi"
 (start) ──▶│ GREETING│───────────────┐
            └─────────┘                ▼
                              ┌────────────────────┐  doc OK
                              │  COLLECTING_DOC[n]  │──────────┐
                              └─────────┬──────────┘           │
                       unclear/wrong doc│  ▲ resend            ▼
                              ┌─────────▼──┐            more docs needed? ──yes──▶ COLLECTING_DOC[n+1]
                              │ REUPLOAD   │                    │ no
                              └────────────┘                    ▼
                                                        ┌────────────────┐ field missing
                                                        │   ASK_FIELD    │◀────────────┐
                                                        └───────┬────────┘             │
                                                       all fields present              │
                                                                ▼                       │
                                                        ┌────────────────┐  CHANGE      │
                                                        │    SUMMARY     │──────────────┘
                                                        └───────┬────────┘
                                                          CONFIRM│
                                                                ▼
                                                        ┌────────────────┐
                                                        │ AWAIT_CONFIRM  │
                                                        └───────┬────────┘
                                              ┌─────────────────┼──────────────────┐
                                         CONFIRM            no reply (timeout)   CHANGE
                                              ▼                  ▼                  ▼
                                        ┌──────────┐      ┌──────────────┐    back to SUMMARY
                                        │SUBMITTED │      │ INCOMPLETE   │
                                        └────┬─────┘      │ (reminders→  │
                                  admin "Ask │            │  expire)     │
                                  correction"▼            └──────────────┘
                                        ┌──────────────┐
                                        │ CORRECTION   │── dealer sends fix ─▶ re-CHECK ─▶ SUMMARY
                                        └──────────────┘
```

`current_state` + `expected_document_type` are persisted on `whatsapp_onboarding_sessions` so a dealer
who drops off **resumes exactly where they left** (§8 "continue from where they left off").

---

## 5. The 4 things done per document — SAVE · READ · CHECK · FILL (from §6)

```text
1. SAVE  Keep the original exactly as sent.
         → download media via adapter → upload to Supabase bucket `dealer-documents`
           path: whatsapp/{applicationId}/{documentType}/{ts}-{uuid}.{ext}
         → insert dealerOnboardingDocuments row (source='whatsapp')

2. READ  Extract fields with Gemini Flash (vision). Per doc type:
         GST cert → gstin, legal_name, address    PAN → pan, name
         Bank stmt → bank_name, acct_no, ifsc      Cheque → acct_no, ifsc, name
         Udyam → udyam_no                          Legal (deed/MoU/AoA) → entity, parties
         Photo → face present? legible?
         → store in dealerOnboardingDocuments.extracted_data (jsonb) + extraction_confidence

3. CHECK Verify with Decentro where an API exists:
         GST → validateDocument(GSTIN)    PAN → validateDocument(PAN)
         Udyam → validateDocument(UDYAM)  Bank → verifyBankAccount(acct,ifsc) [name match]
         → store in dealerOnboardingDocuments.api_verification_results (jsonb)
         → name-mismatch / failed check → add to application.verification_warnings (NOT a silent pass)

4. FILL  Map confirmed values into the draft application columns via /dealer-onboarding/save.
```

---

## 6. Extraction & verification platforms (cost comparison)

Primary engine = **Gemini Flash + Decentro verify**. The others are documented for completeness and as
swap-in options.

| Platform | Covers | Pricing model | ~Cost / 500 dealers/mo | Role in this design |
|---|---|---|---|---|
| **Gemini Flash (LLM)** | All 8 doc types **incl. legal docs** (deed/MoU/AoA) | per token | **₹200 – ₹3,000** | **PRIMARY** reader/extractor (vision). Also parses CONFIRM/CHANGE natural replies. |
| **Document AI / Textract (OCR)** | OCR all docs; structured form parsing extra | per page | ₹1,900 (OCR) → ₹40,000+ (forms) | **Optional fallback** for low-confidence Gemini reads / dense bank-statement tables. |
| **Decentro (KYC API)** | GST / PAN / Udyam / cheque **verification only** | per call | ₹7,500 – ₹12,500 (+ per-verify) | **PRIMARY verifier** — the authoritative GST/PAN/Udyam/bank check. Does not "read" legal docs. |

**Why this mix:** Gemini Flash is cheapest and the only one covering legal docs + free-text fields;
Decentro is the trusted *verification* authority (its read coverage is narrow). OCR services are kept as
a precision fallback when a Gemini read is below the confidence threshold.

**Confidence policy:** if `extraction_confidence < threshold` → run OCR fallback; if still low → bot asks
the dealer to resend or type the value (agentic, §12.3).

### 6.1 Gemini Flash vs Decentro — division of labour

These two are **not alternatives** — they are a pipeline (**READ → CHECK**). One *reads* the document,
the other *proves the reading is genuine*. Neither can do the other's job.

| | **Gemini Flash** | **Decentro** |
|---|---|---|
| Job | **READ** — turn a photo/PDF into text fields | **CHECK** — confirm those fields are real & valid |
| Input | An image or PDF the dealer sent | A *value* (GSTIN, PAN, account no.) |
| Output | "This document says GSTIN = 27ABCDE1234F1Z5, name = ABC Motors" | "That GSTIN is real, active, registered to ABC Motors" |
| Source of truth | The pixels in the document | Government / banking databases (GSTN, NSDL, NPCI) |

**Why Decentro alone is not enough.** Decentro cannot look at a document — you cannot hand it a photo of
a GST certificate. It only takes a *value* and tells you if that value is valid. Without Gemini, the only
way to get the GSTIN out of the uploaded certificate is to make the dealer **type it by hand** on
WhatsApp — which defeats the entire premise of document-driven onboarding. **Gemini reads the number off
the document so the dealer does not have to type it.**

**Why Gemini alone is not enough.** Gemini reading "GSTIN = 27ABCDE1234F1Z5" only tells you *what the
paper claims*. It cannot tell you whether that GSTIN is actually registered, active, or matches the
company name — and a forged/photoshopped certificate will be "read" just as happily as a real one. Only
**Decentro**, by querying the actual government/banking source, can say "this is real" or "this does not
exist / name mismatch." **Decentro proves the number Gemini read is genuine, not forged.**

**Worked example — one GST certificate:**
```text
Dealer sends GST_certificate.pdf
        │
        ▼  GEMINI FLASH (READ) — extraction, no validation
   "It is a GST certificate. GSTIN = 27ABCDE1234F1Z5, legal name = ABC Motors Pvt Ltd"
        │
        ▼  DECENTRO (CHECK) — validation, cannot read pixels
   validateDocument("27ABCDE1234F1Z5")
   → Govt: VALID, status=ACTIVE, name="ABC MOTORS PRIVATE LIMITED" → name matches ✓
        │
        ▼  FILL with a value that is BOTH correctly read AND government-verified
```
Remove Gemini → the dealer types the GSTIN by hand (no document-driven onboarding).
Remove Decentro → you accept whatever the paper says, including forgeries (no fraud protection).

**The legal-docs gap (second reason Gemini is essential).** Decentro only covers **GST / PAN / Udyam /
cheque**. It has **no API** for Partnership Deed, MoU, AoA, ITR, bank-statement PDFs, or owner/partner/
director photos — there is no government number to check, so there is nothing to "verify." For all of
those, the only possible action is to **read** them (Gemini) and present the extracted details to the
Sales Admin. Decentro cannot participate at all.

**One-line summary:** *Gemini reads the document; Decentro proves the reading is real.* Gemini works on
**every** document (incl. legal docs Decentro can't touch); Decentro works only on the 4 verifiable
number-types and is the authority that stops forgery.

---

## 7. Credentials required

### 7.1 WhatsApp — Interakt (primary)
| Env var | Purpose |
|---|---|
| `INTERAKT_API_KEY` | Auth for send + media-download REST calls |
| `INTERAKT_BASE_URL` | API base (e.g. `https://api.interakt.ai/v1/public`) |
| `INTERAKT_WEBHOOK_SECRET` | HMAC/secret to verify inbound webhook authenticity |
| `INTERAKT_WABA_PHONE` / `INTERAKT_PHONE_NUMBER_ID` | Sending business number identity |
| `WHATSAPP_PROVIDER` | Adapter selector: `interakt` (default) \| `meta` \| `gupshup` |

### 7.2 WhatsApp — Meta Cloud API (future swap)
`META_WA_PHONE_NUMBER_ID`, `META_WA_BUSINESS_ACCOUNT_ID`, `META_WA_ACCESS_TOKEN` (permanent),
`META_WA_APP_SECRET` (webhook X-Hub-Signature-256), `META_WA_VERIFY_TOKEN` (GET challenge).

### 7.3 WhatsApp — Gupshup (existing fallback)
Already present: `GUPSHUP_API_KEY`, `GUPSHUP_APP_NAME`, `GUPSHUP_SOURCE`, `GUPSHUP_CHANNEL=whatsapp`,
`GUPSHUP_TEMPLATE_ID`, `GUPSHUP_ENDPOINT` (see `src/lib/gupshup.ts`).

### 7.4 Extraction
| Env var | Purpose |
|---|---|
| `GOOGLE_GENAI_API_KEY` (or `GEMINI_API_KEY`) | Gemini Flash vision/text extraction + intent parsing |
| `GEMINI_MODEL` | e.g. `gemini-2.0-flash` |
| *(optional)* `GCP_DOCUMENT_AI_PROCESSOR_ID` + `GOOGLE_APPLICATION_CREDENTIALS` | Document AI OCR fallback |
| *(optional)* `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | Textract OCR fallback |

### 7.5 Verification — Decentro (existing)
`DECENTRO_CLIENT_ID`, `DECENTRO_CLIENT_SECRET`, `DECENTRO_BASE_URL`,
`DECENTRO_MODULE_SECRET_KYC` (GST/PAN/Udyam), `DECENTRO_MODULE_SECRET_BANKING`, `DECENTRO_PROVIDER_SECRET`.

### 7.6 Storage / queue / DB (existing)
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (admin upload),
`QSTASH_TOKEN`, `QSTASH_URL`, `QSTASH_CALLBACK_BASE_URL`, `REDIS_URL` (session lock + dedupe), `DATABASE_URL`.

---

## 8. Database design

> Strategy: **reuse** the two onboarding tables (so the Sales Admin panel works unchanged) and **add**
> two WhatsApp-specific tables + a few additive columns. All migrations are **idempotent, additive**
> (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`) per the repo's `drizzle/E-XXX_*.sql` rule.
> Mirror each change in `src/lib/db/schema.ts`. Next free migration: `drizzle/E-XXX_whatsapp_onboarding.sql`.

### 8.1 NEW — `whatsapp_onboarding_sessions`
One row per dealer conversation; drives the state machine + resume.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `wa_phone` | varchar | dealer E.164, indexed (lookup on inbound) |
| `wa_contact_name` | text | WhatsApp profile name |
| `provider` | varchar | `interakt` \| `meta` \| `gupshup` |
| `provider_conversation_id` | text | provider thread/contact id |
| `application_id` | uuid FK → `dealer_onboarding_applications.id` | the draft being filled |
| `current_state` | varchar | GREETING \| COLLECTING_DOC \| ASK_FIELD \| SUMMARY \| AWAIT_CONFIRM \| SUBMITTED \| INCOMPLETE \| CORRECTION |
| `expected_document_type` | varchar | which doc the bot is currently waiting for |
| `detected_company_type` | varchar | sole_proprietorship \| partnership_firm \| private_limited_firm \| llp |
| `language` | varchar | en \| hi \| hinglish |
| `context` | jsonb | collected answers, pending questions, checklist progress |
| `reminder_count` | integer | for the no-response nudge |
| `last_inbound_at` / `last_outbound_at` / `last_reminder_at` | timestamptz | timers |
| `session_status` | varchar | active \| awaiting_confirmation \| submitted \| incomplete \| expired |
| `created_at` / `updated_at` | timestamptz | |

Indexes: `(wa_phone)`, `(session_status, last_inbound_at)` (reminder sweep), `(application_id)`.

### 8.2 NEW — `whatsapp_messages`
Append-only log of every inbound/outbound message → audit + **idempotency** + delivery tracking.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `session_id` | uuid FK → `whatsapp_onboarding_sessions.id` | |
| `provider_message_id` | text **UNIQUE** | dedupe key (skip if already seen) |
| `direction` | varchar | inbound \| outbound |
| `message_type` | varchar | text \| image \| document \| audio \| template \| interactive |
| `text_body` | text | message text / caption |
| `media_provider_id` | text | provider media handle (before download) |
| `storage_path` | text | Supabase path once SAVEd |
| `template_name` | text | outbound template used (24h-window sends) |
| `delivery_status` | varchar | sent \| delivered \| read \| failed (from status webhooks) |
| `raw_payload` | jsonb | full provider event, for debugging |
| `created_at` | timestamptz | |

### 8.3 EXTEND — `dealer_onboarding_applications` (additive columns)
| Column | Type | Purpose |
|---|---|---|
| `source` | varchar default `'web'` | `'web'` \| `'whatsapp'` — Sales Admin list filter/badge |
| `wa_phone` | varchar | originating WhatsApp number |
| `wa_session_id` | uuid | link back to the conversation |
| `verification_warnings` | jsonb | failed/mismatched checks surfaced to admin (§8 rule) |
| `extraction_summary` | jsonb | per-field value + source doc + confidence |
| `dealer_confirmed_at` | timestamptz | set on WhatsApp CONFIRM (gate to submit) |

> `onboarding_status` reuses existing enum values: WhatsApp drafts use `draft` → on CONFIRM →
> `submitted` (same state the web wizard uses), so the admin panel needs **no new status**.

### 8.4 REUSE — `dealer_onboarding_documents` (+ a few additive columns)
Already has `extracted_data` (jsonb) and `api_verification_results` (jsonb) — perfect fit. Add:

| Column | Type | Purpose |
|---|---|---|
| `source` | varchar default `'web'` | `'whatsapp'` for WhatsApp-collected files |
| `wa_message_id` | uuid | link to the `whatsapp_messages` row that delivered it |
| `extraction_engine` | varchar | `gemini` \| `documentai` \| `textract` \| `manual` |
| `extraction_confidence` | numeric | 0–1, drives the fallback policy |
| `verification_provider` | varchar | `decentro` \| none |

---

## 9. API routes

| Method · Route | Purpose | Pattern reused |
|---|---|---|
| `GET /api/whatsapp/webhook` | Provider verification challenge (Meta `hub.challenge`; Interakt no-op) | — |
| `POST /api/whatsapp/webhook` | **Ingress.** Read raw body → HMAC verify → dedupe `provider_message_id` → `publishToPath('/api/whatsapp/process')` → **200 fast-ack** | Razorpay HMAC + QStash |
| `POST /api/whatsapp/process` | **Worker (QStash callback).** Run one agentic turn: SAVE→READ→CHECK→FILL→reply. Redis-lock per `session_id` to serialize a dealer's turns | Bolna `after()` + QStash |
| `POST /api/whatsapp/media/[mediaId]` | Internal: download provider media → upload to `dealer-documents` → return storage path | `/api/uploads/dealer-documents` |
| `POST /api/whatsapp/send` | Internal: orchestrator → adapter `send()` (text/template/interactive) | `src/lib/gupshup.ts` |
| `POST /api/dealer-onboarding/save` | **Reused** — orchestrator persists extracted fields + documents into the draft | existing |
| `POST /api/whatsapp/correction-notify` | Admin "Ask Correction" → message dealer on WhatsApp + set session `CORRECTION` | existing admin action hook |
| `GET /api/admin/.../applications?source=whatsapp` | **Reused** review list with a `source` filter/badge — no separate queue (§12.5) | existing |
| `POST /api/cron/whatsapp-reminders` | Vercel cron: nudge `active` sessions idle > N; expire after too long (§8) | existing cron + scheduler |

**Ingress contract (critical):** webhook must return 200 within provider timeout. All heavy work
(extraction, Decentro calls, LLM) happens in `/api/whatsapp/process`, never inline in the webhook.

---

## 10. WhatsApp adapter interface (provider abstraction, §12.1)

```ts
// src/lib/whatsapp/types.ts
export interface InboundEvent {
  providerMessageId: string;
  waPhone: string;           // E.164
  contactName?: string;
  type: 'text' | 'image' | 'document' | 'audio' | 'interactive' | 'status';
  text?: string;
  mediaProviderId?: string;  // resolve via downloadMedia()
  mimeType?: string;
  raw: unknown;
}

export interface WhatsAppAdapter {
  verifyInbound(headers: Headers, rawBody: string): boolean;     // HMAC / secret
  parseInbound(rawBody: string): InboundEvent[];                 // normalize
  downloadMedia(mediaProviderId: string): Promise<{ buffer: Buffer; mimeType: string }>;
  sendText(to: string, body: string): Promise<{ providerMessageId: string }>;
  sendTemplate(to: string, name: string, vars: Record<string,string>): Promise<{ providerMessageId: string }>;  // 24h window
  sendInteractive(to: string, buttons: {id:string;title:string}[]): Promise<{ providerMessageId: string }>;     // CONFIRM/CHANGE
}
```
Implementations: `interakt.ts` (primary), `meta.ts` (future), `gupshup.ts` (wrap existing).
Selected at runtime by `WHATSAPP_PROVIDER`. The orchestrator depends only on `WhatsAppAdapter`.

---

## 11. Documents & fields by dealer type (verbatim from §12.2 — nothing dropped)

**Common documents (all currently-implemented dealer types):** GST Certificate · Company PAN ·
Last 3 Years Company ITR · Last 3 Months Company Bank Statement · 4 Undated Cheques · Passport-size
Photograph · Udyam Registration Certificate.

**Common company fields:** Company name · Company address · Company type · GST number · Company PAN
number · Business details summary.

**Common bank fields:** Bank name · Account number · IFSC · Beneficiary name · Branch · Account type.

| Dealer type | Extra requirements |
|---|---|
| **Sole proprietor** | Owner: name, phone, email, age, photograph; residential address: line 1, city, district, state, pin code |
| **Partnership firm** | Partnership Deed; ≥1 partner; per partner: name, phone, email, age, photograph, address line 1, city, district, state, pin code |
| **Private limited** | MoU; AoA; ≥1 director; per director: name, phone, email, age, photograph, address (as above) |
| **LLP** | Not yet a separate type in the wizard → **either** add LLP as a new company type **or** map to the partnership-style flow after business confirmation |
| **Branch dealer** | Not a separate wizard type → follow the underlying legal entity's docs; branch handling done during Sales Admin review (matching-GST cases already treated as branch/additional-location review) |

**Details the bot may ask directly** (not reliably in documents, §5): owner name · mobile · email ·
company type · business address confirmation · bank branch · finance enablement (yes/no) · agreement
language / signatory details (if required).

---

## 12. Dealer confirmation (from §7) — masking + natural replies

Summary message (sensitive numbers partly hidden):
```text
Please confirm your dealer onboarding details:

Company: ABC Motors
GST: 27ABCDE****1Z5
PAN: ABCDE****F
Bank: HDFC Bank
Account: XXXXXXXX1234
IFSC: HDFC****234
Documents received: GST, PAN, Bank Statement, Photo

Reply CONFIRM to submit.   Reply CHANGE if anything is wrong.
```
- Treat as **confirm**: `CONFIRM`, `OK`, `YES`, `HAAN` (+ natural variants via Gemini intent parse).
- Treat as **correct**: `CHANGE`, `EDIT`, `WRONG`, `CORRECT`.
- Only after CONFIRM does the application move to Sales Admin. Masking applied to GST/PAN/account/IFSC.

---

## 13. Error & edge handling (from §8)

| Situation | System behavior |
|---|---|
| Unclear photo/PDF | "This document is not clear. Please resend a clearer photo or PDF." (low `extraction_confidence`) |
| Wrong document | "This doesn't look like a GST certificate. Please send your GST certificate." (type mismatch on READ) |
| Details don't match (e.g. bank name ≠ company/owner) | Mark a **warning** → may ask dealer to correct → **always** visible to Sales Admin |
| Failed GST/PAN/bank check | **Never a silent pass** → ask dealer to correct **or** forward to admin with a clear warning |
| Dealer stops responding | Reminder after a delay (cron); resume where left off; mark `incomplete` if no response too long |
| Dealer wants to correct | CHANGE → bot asks what → dealer sends fix → re-check → summary again → re-confirm |

---

## 14. Sales Admin review flow (from §4 & §9 — unchanged authority)

```text
New WhatsApp onboarding application (source=whatsapp) arrives
        ↓ alert to Sales Admin (existing alert channel)
Appears in the NORMAL Sales Admin review list (not a separate WhatsApp queue)
        ↓ admin opens detail and sees:
   company details · GST/PAN/bank · ALL original documents ·
   what the system extracted · verification status + warnings
        ↓
   APPROVE → dealer continues normal process (agreement initiated by admin later, §12.4)
   REJECT  → dealer informed on WhatsApp
   ASK CORRECTION → dealer notified on WhatsApp → sends corrected doc/detail → re-check → admin re-reviews
```
**What stays the same (§9):** admin still approves/rejects/asks-correction · originals still saved ·
records still populated in the main system · merges into the normal dealer-onboarding process ·
**dealer agreement is NOT auto-started** before review — admin initiates it post-review (§12.4).

---

## 15. Implementation blocks (from §10) → mapped to this design

| Block | Description | Lands in |
|---|---|---|
| 1. WhatsApp entry point | Receive messages + media from official number | C1 adapter + `POST /api/whatsapp/webhook` |
| 2. Document saving | Save originals in today's storage process | C4 → Supabase `dealer-documents` |
| 3. Document reading | GST/PAN/company/address/bank/IFSC/signatory | C5 → Gemini Flash (+OCR fallback) |
| 4. Verification | GST/PAN/bank where available | C6 → Decentro |
| 5. Application filling | Extracted+verified → application | C7 → `/dealer-onboarding/save` |
| 6. Dealer confirmation | Masked summary + final confirm | C8 |
| 7. Sales Admin handoff | On confirm → review panel + alert | C9 (existing panel) |
| 8. Correction loop | Admin asks → dealer fixes on WhatsApp | C10 + `/api/whatsapp/correction-notify` |

---

## 16. Security, privacy & reliability
- **Webhook auth:** verify provider HMAC/secret on every inbound; reject unsigned.
- **Idempotency:** unique `provider_message_id`; duplicate deliveries are no-ops.
- **Concurrency:** Redis lock per `session_id` so a dealer's rapid messages process in order.
- **PII masking:** GST/PAN/account/IFSC masked in all WhatsApp text; full values only in DB + admin panel.
- **DPDPA:** originals in a private bucket; access via service role; extracted PII in jsonb, not message logs.
- **No silent approval:** enforced at the FILL step — warnings always persisted and surfaced.
- **Resumability:** `current_state` + checklist in `context` make every session resumable after a drop.

---

## 17. One-view end-to-end (from §11, with engine names)

```text
START
  → Dealer messages iTarang WhatsApp (Interakt adapter)
  → Webhook: HMAC verify + dedupe + enqueue (QStash) → 200
  → Orchestrator opens/loads session + draft application
  → Bot requests required documents one by one (by detected dealer type)
  → Dealer sends documents
  → SAVE originals (Supabase dealer-documents)
  → READ fields (Gemini Flash; OCR fallback if low confidence)
  → CHECK GST/PAN/bank/Udyam (Decentro) → warnings on mismatch
  → FILL onboarding application (/dealer-onboarding/save)
  → Bot sends masked summary
  → Dealer confirms?
       No  → correct detail/document → re-check → summary again
       Yes → submit to Sales Admin (source=whatsapp) + alert
  → Admin reviews: Approve / Reject / Ask Correction
       Ask Correction → notify dealer on WhatsApp → fix → re-review
```

---

## 18. Final decisions (from §12, preserved)
1. **Provider:** WhatsApp API required; **Interakt first** via inbound webhooks + media APIs; Meta Cloud
   API is the long-term option; **hidden behind an internal adapter** for zero-rewrite switching.
2. **Mandatory docs/fields:** source of truth = existing `itarang-software` onboarding validation/submit
   (enumerated in §11 above).
3. **Corrections:** WhatsApp-first, agentic; existing correction link stays as admin/fallback tool.
4. **Dealer agreement:** not auto-started pre-review; admin initiates post-review.
5. **Review alerts:** Sales Admin alerted; application shows in the **normal** review panel, not a
   WhatsApp-only queue.

---

## 19. Verification / testing plan
- **Static:** `npm run type-check` after schema + route additions.
- **Adapter unit:** mock Interakt payloads → `parseInbound` produces canonical `InboundEvent`; HMAC pass/fail.
- **Idempotency:** replay same `provider_message_id` → exactly one document row, one reply.
- **Extraction:** feed sample GST/PAN/bank/legal images → assert extracted fields + confidence; force a
  low-confidence read → OCR fallback fires; force unreadable → bot asks resend.
- **Verification:** Decentro sandbox (`DECENTRO_BASE_URL` sandbox) for GST/PAN/bank; name mismatch →
  `verification_warnings` populated and shown in admin detail.
- **End-to-end (sandbox WhatsApp):** "Hi" → send each doc → masked summary → "CONFIRM" → row appears in
  Sales Admin list with `source=whatsapp`, all originals viewable; "Ask Correction" → dealer gets WhatsApp
  message → resend → re-review.
- **Resume:** drop mid-flow, send a new message → continues at saved `current_state`.

---

## Appendix A — Source business note (§1–§13) mapping

This design preserves **every** section of the original `dealer-whatsapp-onboarding-architecture.md`:

| Original § | Title | Where it lives here |
|---|---|---|
| §1 | What we are building | §0 principles + §1 architecture |
| §2 | Big picture flow | §1 architecture diagram |
| §3 | Dealer experience flow | §3 |
| §4 | Sales Admin review flow | §14 |
| §5 | Documents collected | §11 |
| §6 | What the system does (SAVE/READ/CHECK/FILL) | §5 |
| §7 | Dealer confirmation before submission | §12 |
| §8 | What happens if there is a problem | §13 |
| §9 | What stays the same | §14 (callout) |
| §10 | Implementation blocks | §15 |
| §11 | End-to-end flow in one view | §17 |
| §12 | Final decisions | §18 (+ §11 docs, §7 creds) |
| §13 | Optional engineering note | §0 principle 1 + §1 layering rule |
