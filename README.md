Hola!
This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).
 hello  world!!
## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.



NBFC Portal → Lead Intelligence (left sidebar) → click a row to open the lead detail drawer → scroll to the "Risk Actions" section → red "Flag for Recovery" button.

 - File: src/app/(dashboard)/nbfc/leads/_components/LeadsTable.tsx:251
 - It opens a confirmation dialog: src/components/nbfc-portal/FlagForRecoveryDialog.tsx
 - The dialog POSTs to /api/nbfc/actions/flag-for-recovery → which creates the needs_inspection pipeline row (the start of everything we walked through).

 The cast of our example

  - Borrower: Ramesh, who took a loan from "iTarang Finance" to buy an e-rickshaw battery.
  - Battery: serial BAT-7788, originally worth ₹1,00,000.
  - Ramesh stopped paying EMIs for months. The NBFC has now physically taken the battery back.

  The whole journey is just a battery moving through 5 boxes (stages):

  Needs Inspection → Refurbishable → Ready for Auction → Resold
                   ↘ Scrap (dead end)

  Example - Think of it like a returned phone at a shop: first we inspect it, then decide "fix & resell" or "throw away", then put it on the shelf for buyers, then
  someone buys it.
 ----
  STAGE 1 — The battery enters the pipeline ("Flag for Recovery")

  Nothing happens automatically. A human at the NBFC clicks "Flag for Recovery" on Ramesh's loan.
  The system then:
  - Stamps Ramesh's loan as "flagged for recovery" (this can never be undone — it's permanent).
  - Creates a new row in the recovery pipeline for battery BAT-7788 at stage needs_inspection.

  👉 This is the moment your dashboard counter moves. Right now your screen says "Recovery in Motion: ₹0 · 0 batteries" because no one has flagged anything — the
  pipeline is empty. The instant Ramesh's battery is flagged, it becomes "1 battery".

  ▎ Simple analogy: a customer returns a product. You put it in the "to be checked" tray. The tray now has 1 item.
 ---
 STAGE 2 — Battery Evaluation (the 3-step form)

 A technician opens battery BAT-7788 (sitting in Needs Inspection) and fills a 3-step form:
 Step 1 – Technical health:
  - State of Health (SOH) = 80% (this is the key number — how much life is left)
  - Physical condition = Fair, BMS = Healthy, IoT = Online

  Step 2 – What do we do with it?
  - Decision = "minor repair" (not scrap)
  - Estimated repair cost = ₹3,000

  Step 3 – Pricing:
  - Original value = ₹1,00,000
  - Reject? = No

   Now the system automatically calculates a starting auction price using a fixed rule based on SOH:

  ┌──────────────────────┬────────────────────────────────┐
  │ Battery health (SOH) │     Price = % of original      │
  ├──────────────────────┼────────────────────────────────┤
  │ Above 85%            │ 67.5%                          │
  ├──────────────────────┼────────────────────────────────┤
  │ 70%–85%              │ 57.5% ← Ramesh's battery (80%) │
  ├──────────────────────┼────────────────────────────────┤
  │ Below 70%            │ 40%                            │
  ├──────────────────────┼────────────────────────────────┤
  │ Rejected / scrap     │ ₹0                             │
  └──────────────────────┴────────────────────────────────┘

   So BAT-7788 → 57.5% × ₹1,00,000 = ₹57,500 base auction price.

   And the battery automatically moves to the next box:

  - Decision was "minor repair" → moves to Refurbishable
  - (If the technician had said "scrap" or SOH was terrible, it would move to Scrap — a dead end, price ₹0, journey over.)

    ▎ Analogy: you checked the returned phone. Screen's a bit scratched but works fine (80% health). You decide "polish it and resell   for     ₹57, 500" instead of throwing it away.

 ---
  STAGE 3 — Put it up for auction ("Ready for Auction")
   After the small repair is done, an operator drags the battery card from Refurbishable → Ready for Auction.

  The moment that happens, the system automatically creates an auction listing (a "lot") in one single safe step:
  - Lot code: LOT-7A3F9C21 (auto-generated)
  - Starting price: ₹57,500 (from the evaluation)
  - Minimum bid increase: ₹1,200 (2% of base, so bids go up in sensible steps)
  - Auction runs for 7 days, then closes.

  Analogy: the polished phone goes onto the auction shelf with a ₹57,500 price tag and a "bidding ends in 7 days" sticker.

  STAGE 4 — Bidding

  Now other Dealer / buyers see LOT-7A3F9C21 on the Auction Marketplace and place bids. Live countdown timer ticks down.
  

-------------------------
WhatsApp-specific tables (new in E-167)

  1. whatsapp_onboarding_sessions — the state machine, one row per dealer phone number
  - wa_phone (unique), application_id (FK), current_state (GREETING → ASK_COMPANY_TYPE → COLLECTING_DOC → … → SUBMITTED), detected_company_type,
  expected_document_type, context (jsonb: collected answers + checklist progress), session_status, inbound/outbound timestamps. Lets a dropped chat resume.

  2. whatsapp_messages — append-only inbound/outbound message log
  - provider_message_id (UNIQUE — Meta webhook idempotency/dedupe), direction, message_type, text_body, media_provider_id/storage_path, delivery_status,
  raw_payload (jsonb). Used for audit + delivery tracking.

  Shared tables (web wizard + WhatsApp, with E-167 extensions)

  3. dealer_onboarding_applications — the main application record. WhatsApp writes here too, tagged source='whatsapp', plus new columns: wa_phone, wa_session_id
  (FK), verification_warnings, extraction_summary, dealer_confirmed_at. Holds all the actual dealer data (company, GST, PAN, owner, bank details).

  4. dealer_onboarding_documents — uploaded doc metadata + extraction. WhatsApp rows get source='whatsapp', extraction_engine='gemini', extraction_confidence,
  verification_provider. extracted_data (jsonb) holds the Gemini-parsed fields.

  Correction-flow tables (admin requests fixes, dealer replies on WhatsApp)

  5. dealer_correction_rounds — one per correction round (requested fields/docs, remarks, magic-link token).

  6. dealer_correction_items — one row per requested field/document, with before/after values for diffing.

  Flow at a glance

  First inbound message creates a whatsapp_onboarding_sessions row + a draft dealer_onboarding_applications → docs go into dealer_onboarding_documents (Gemini
  extraction) and fields fill the application → every message logged in whatsapp_messages → dealer confirms (dealer_confirmed_at set, status submitted) → any
  admin corrections use the two dealer_correction_* tables.

  Key code: src/lib/whatsapp/orchestrator.ts (state machine + writes), src/app/api/whatsapp/webhook/route.ts (ingress), src/lib/whatsapp/notifications.ts,
  src/lib/whatsapp/storage.ts.


  ---whatsapp new lead flow(chatbot)

   WhatsApp Dealer Self-Service: Lead Creation, Customer KYC, Inventory & Co-Borrower

 Context

 Today the WhatsApp bot only does dealer onboarding (dealer-first: dealer sends "hi"/"onboarding" → bot walks them through documents → admin approves → dealer
 gets a login). Once approved, the dealer has to leave WhatsApp and use the web portal for everything else.

 The goal: after a dealer is approved, let them do their day-to-day lead work from the same WhatsApp number — create multiple leads, share the customer's KYC
 documents, check their inventory, and respond to admin co-borrower requests — by mostly just sharing documents and tapping a few buttons. Leads created this
 way land in the existing admin KYC Review queue; the admin verifies them exactly as they do for portal leads. Nothing about the desktop portal or the admin
 verification screens changes — WhatsApp becomes an additional front-end onto the same lead/KYC backend.

 Decisions locked with the user:
 - Lead inputs: the few fields not derivable from documents (product, payment method, interest level, finance gates) are asked as quick button/list questions,
 producing a complete, submit-ready lead.
 - KYC depth: the bot collects + attaches documents and extracted data, then submits to the admin queue. The admin runs the Decentro PAN/Aadhaar/bank checks &
 consent in the existing KYC Review screen ("dealer just shares documents").
 - Eligibility: any approved/active dealer (WhatsApp-onboarded or web-onboarded), matched by phone.
 - Co-borrower: admin-triggered. When the customer's CIBIL is low the admin requests a co-borrower; the dealer then sends the co-borrower's details + documents
 over WhatsApp.

 ---
 Architecture at a glance

 One inbound WhatsApp message → webhook → runTurn. We add an identity fork at the very top of runTurn:

 inbound msg (wa_phone)
   │
   ├─ resolveWhatsAppDealer(wa_phone) -> approved/active dealer?
   │        │
   │        ├─ YES  -> runDealerTurn()   (NEW: lead / inventory / co-borrower / drafts)
   │        └─ NO   -> existing onboarding runTurn()   (UNCHANGED)

 This is the only change to the onboarding path: an approved dealer messaging "hi" no longer restarts onboarding — they get the dealer menu instead. Non-dealers
 keep the existing onboarding flow verbatim.

 The new dealer-mode reuses the proven onboarding primitives (session row + context JSONB state machine, whatsapp_messages log + dedupe, Gemini extraction.ts,
 storage.ts media save, reply() / interactive lists) but persists each lead as a real leads draft row, so WhatsApp drafts and portal drafts are the same
 records.

 ---
 Part 1 — Dealer identity resolution

 New: src/lib/whatsapp/dealer-identity.ts → resolveWhatsAppDealer(waPhone): Promise<{ dealerCode, dealerUserId, financeEnabled } | null>.

 Lookup order (reuse phoneLookupVariants() from src/lib/ai/phone.ts):
 1. dealer_onboarding_applications where wa_phone = waPhone AND onboarding_status = 'approved' → dealer_code, dealer_user_id.
 2. Fallback: dealers where owner_phone IN phoneLookupVariants(waPhone) AND onboarding_status = 'active' → join users(role='dealer', dealer_id=...) for
 dealer_user_id.

 Returns null if no active dealer → caller falls through to onboarding. dealerUserId becomes the lead's uploader_id; dealerCode becomes dealer_id (satisfies the
 E-105 gate in leads/create).

 ---
 Part 2 — Dealer-mode session + global command router

 New table (migration drizzle/E-XXX_whatsapp_dealer_sessions.sql, mirror in schema.ts):

 whatsapp_dealer_sessions: id, wa_phone (idx), dealer_code, dealer_user_id, current_state (default MENU), active_lead_id (nullable — the draft currently being
 edited), context jsonb, session_status, timestamps. Keyed/looked-up by wa_phone. Strictly additive; does not touch whatsapp_onboarding_sessions.

 Reuse whatsapp_messages for inbound dedupe + outbound logging. Add a nullable dealer_session_id uuid column (additive) so dealer-mode messages log without
 faking an onboarding session_id.

 New: src/lib/whatsapp/dealer-orchestrator.ts → runDealerTurn(event, dealer).

 Global commands are intercepted before the per-lead state machine (like onboarding's greeting trigger), so they work mid-lead without corrupting the active
 draft:
 - menu / hi / hello → main menu (interactive buttons: New Lead, My Drafts, Inventory).
 - new lead → start a fresh lead draft.
 - my drafts / leads → list open drafts (interactive list), tap to resume.
 - inventory / stock → inventory summary (Part 5).
 - cancel / pause → "Saved. Send menu anytime." (no-op; everything is autosaved).
 - help → short usage text.

 ---
 Part 3 — Lead creation flow (state machine)

 States stored on whatsapp_dealer_sessions.current_state, bound to active_lead_id. Every turn autosaves to the lead's row via the extracted saveDraft service —
 no explicit save needed.

 1. LEAD_START → initializeDraft service → new leadId (status INCOMPLETE); set active_lead_id. Prompt: "Send the customer's Aadhaar (front & back) and PAN to
 begin, or type their name."
 2. LEAD_COLLECT_DOCS → dealer sends customer docs (image/PDF). Reuse extraction.ts with customer doc field sets (Aadhaar → name, dob, address, aadhaar_no; PAN
 → pan_no, name; cheque/bank → account, ifsc, bank). Each doc is saved (storage.ts), attached as a kyc_documents row (doc_for='customer') via the extracted
 upload service, and extracted fields are saveDraft'd onto the lead.
 3. LEAD_ASK_MISSING → ask only what documents can't give, via buttons/lists:
   - customer phone (required), email (required for downstream Digio), confirm name/dob/address if low confidence.
   - product via the Part-4 picker.
   - interest level (buttons: Hot/Warm/Cold).
   - payment method (buttons: Cash / Finance).
   - if finance → resident_status (Owned/Rented), health insurance? (Y/N), life insurance? (Y/N).
 4. LEAD_CONFIRM → masked summary (reuse masking.ts) → CONFIRM.
 5. On confirm → commitLead service (commitStep payload, dealer_id=dealerCode, uploader_id=dealerUserId) → lead becomes ACTIVE.
 6. LEAD_KYC_SUBMIT → submit to admin queue (Part 4) → "✅ Lead #IT-… submitted for KYC verification. Send new lead for another, or my drafts."

 Product picker (interactive lists, reusing dealer-scoped queries):
 - Asset type → 3 buttons (Battery/Charger/Paraphernalia).
 - Category → list from getDealerLeadCategories(dealerCode) (≤6 rows; row id = slug, desc = "N in stock").
 - Product → list from getDealerLeadProducts(dealerCode, slug) (row id = product_id, desc = "48V 60Ah · N available"); >10 → "More…" page or type-to-filter.
 - Tap stores primary_product_id + product_category_id + asset_type; "Add another" → append lead_products. Inventory-driven, so the dealer can only pick stock
 they hold.

 Multi-draft / switching: each lead is an independent INCOMPLETE/kyc_status='draft' row (no uniqueness constraint blocks concurrent drafts). The session only
 tracks active_lead_id. new lead starts another (previous stays saved); my drafts re-lists via the extracted drafts service and repoints active_lead_id. Resume
 point is derived from the saved row (next missing required field) rather than a fragile step counter, so resume works after any gap and survives out-of-order
 answers. WhatsApp drafts appear in the portal "My Drafts" and vice-versa.

 ---
 Part 4 — Customer KYC (collect docs → admin verifies)

 - Customer documents uploaded in Part 3 are stored as kyc_documents (doc_for='customer') with ocr_data/extracted fields, via the extracted upload service.
 - On submit, call the extracted submit-verification service which creates the admin_verification_queue entry (status='pending_itarang_verification') and the
 manual kyc_verifications rows. The lead then appears in /admin/kyc-review/[leadId] and the admin runs Decentro PAN/Aadhaar/bank + consent there. No live
 Decentro/OTP on WhatsApp.
 - Consent gate (explicit sub-decision): the existing dealer-portal submit-verification requires consent verified + the 5 required docs. For WhatsApp-origin
 leads we either (a) recommended: trigger the existing Digio consent e-sign and send the link to the customer (reuse the consent send endpoint) so the existing
 gate is satisfied legitimately, or (b) add a source='whatsapp' submission path that enters the queue in an awaiting_consent sub-state for the admin to drive
 consent from the review screen. Default to (a) if the customer email is reliable; fall back to (b). This is the one place we touch submission preconditions —
 call it out at build time, do not silently relax the compliance gate.

 ---
 Part 5 — Inventory check (global command)

 inventory/stock → reuse getInventorySummary({ dealerId: dealerCode }) for headline totals + the extracted aggregated-inventory service (/api/dealer/inventory
 logic) for per-product counts. Reply a compact text summary; long lists drill down via an interactive list (tap "Batteries" → model-level counts + serials).
 Read-only, no session mutation — safe mid-lead.

 ---
 Part 6 — Admin-triggered co-borrower / additional-docs loop

 The admin actions already exist and set lead statuses but send no dealer notification — we add the WhatsApp delivery + fulfillment.

 1. Outbound trigger: hook the existing admin endpoints POST /api/admin/kyc/[leadId]/step3/request-coborrower and .../request-docs (and the rejection branches
 of final-decision). When they set kyc_status to awaiting_co_borrower_kyc / awaiting_co_borrower_replacement / awaiting_additional_docs / awaiting_both, and the
 lead's dealer has a WhatsApp number, send a WhatsApp message with the admin's reason, e.g. "Customer's CIBIL is low — please add a co-borrower. Reason:
 <reason>. Send the co-borrower's name & phone, then their Aadhaar & PAN." (Best-effort; outside the 24h window this needs a pre-approved template — Part 9.)
 2. Inbound fulfillment: dealer reply enters COBORROWER_* states on the dealer session bound to that leadId:
   - collect co-borrower name/phone/details → POST /api/coborrower/[leadId] service.
   - collect co-borrower docs (Gemini extract) → coborrower/upload-document service (doc_for co-borrower).
   - admin-requested extra docs → coborrower/upload-other-document service (matches other_document_requests.doc_key).
   - then submit → coborrower/[leadId]/submit-verification service → lead pending_itarang_reverification + high-priority queue entry → back to admin.

 ---
 Part 9 — 24-hour window & templates

 Free-form replies (sendText/interactive/lists/documents) are only allowed inside the 24h window opened by the dealer's last inbound message — which covers
 virtually the whole interactive flow, since the dealer is actively chatting. The one place we send unprompted (the admin's co-borrower/doc request in Part 6)
 may land outside the window, so it needs a pre-approved Meta template (e.g. lead_action_required with the reason as a body param), falling back to sendText
 when the window is open. Reuse the adapter's sendTemplate(). All other dealer-mode messages stay free-form/free.

 Part 7 — Service extraction (the main refactor)

 The bot runs server-side with no browser cookie, so the cookie-auth'd route handlers must have their core logic extracted into reusable lib services that
 accept an explicit actor ({ dealerCode, dealerUserId }). Both the existing HTTP route and the bot then call the same service — no duplicated validation.
 Extract (thin route wrapper left in place):

 - leads/create → src/lib/leads/draftService.ts: initializeDraft, saveDraft, commitLead.
 - dealer/leads/drafts → listDealerDrafts(dealerCode).
 - dealer/leads/[id] GET → getLeadForResume(leadId).
 - dealer/leads/categories + products → getDealerLeadCategories / getDealerLeadProducts.
 - dealer/inventory aggregate → getDealerInventoryAggregated(dealerCode) (plus getInventorySummary, already a lib).
 - kyc/[leadId]/upload-document + submit-verification → src/lib/kyc/* services.
 - coborrower/[leadId] save/upload/submit → src/lib/coborrower/* services.

 Representative paths to modify: src/app/api/leads/create/route.ts, src/app/api/dealer/leads/{drafts,categories,products}/route.ts,
 src/app/api/kyc/[leadId]/{upload-document,submit-verification}/route.ts, src/app/api/coborrower/[leadId]/**. Pattern is identical across them: move handler
 body into a service, route validates auth + calls service.

 ---
 Part 8 — New code & schema

 New files:
 - src/lib/whatsapp/dealer-identity.ts — resolveWhatsAppDealer.
 - src/lib/whatsapp/dealer-orchestrator.ts — runDealerTurn + dealer state machine + command router.
 - src/lib/whatsapp/dealer-prompts.ts — customer/co-borrower Gemini field sets + reply copy (extend prompts.ts/extraction.ts rather than duplicate Gemini
 plumbing).
 - src/lib/whatsapp/dealer-notify.ts — outbound co-borrower/doc-request/decision WhatsApp sends.
 - drizzle/E-XXX_whatsapp_dealer_sessions.sql (+ whatsapp_messages.dealer_session_id additive column) and the schema.ts mirror.

 Modified:
 - src/app/api/whatsapp/webhook/route.ts (or top of orchestrator.ts runTurn) — identity fork to runDealerTurn.
 - The admin endpoints in Part 6 — fire dealer-notify after the status transition (best-effort, never block the admin action).
 - The route→service extractions in Part 7.

 Onboarding files (orchestrator.ts document/field handlers, checklist.ts, meta.ts) are untouched except the single fork.

 ---
 Verification (end-to-end)

 Local Meta test setup mirrors the onboarding dev loop (cloudflared tunnel → Meta webhook; see WhatsApp Meta wiring notes — tunnel URL changes per restart):
 1. Identity fork: from an approved dealer's WhatsApp number, send "hi" → expect the dealer menu, not onboarding restart. From an unknown number → onboarding
 still starts.
 2. Lead create: "new lead" → send a sample Aadhaar + PAN image → bot extracts name/dob/pan → answer phone/email, pick product from the inventory list,
 interest, payment=cash → confirm → verify a leads row (status ACTIVE) + kyc_documents (doc_for='customer') + an admin_verification_queue row; confirm it shows
 in /admin/kyc-review.
 3. Multi-draft: start lead A, send "new lead" (B), send "my drafts" → list shows A; tap A → resumes at the next missing field. Confirm both appear in the
 portal "My Drafts".
 4. Inventory: "inventory" mid-lead → correct per-product counts (cross-check getInventorySummary), and the active draft is unaffected.
 5. Co-borrower loop: as admin, request a co-borrower on a WhatsApp lead → dealer's WhatsApp receives the prompt → reply with co-borrower name/phone +
 Aadhaar/PAN images → bot fulfills via the coborrower services → lead returns to the admin queue as pending_itarang_reverification with a co_borrowers row +
 co_borrower_documents.
 6. Consent: confirm the chosen consent path (e-sign link to customer, or admin-driven) lets the lead clear the existing submit gate.
 7. npm run type-check clean; manual dealer/lead/KYC writes confirmed against the DB.

 Note: this is a large, multi-part feature — recommend building in the order Part 7 (service extraction) → 1–2 (identity + session) → 3–5
 (lead/product/inventory) → 6 (co-borrower) → 9 templates, each verifiable on its own.  