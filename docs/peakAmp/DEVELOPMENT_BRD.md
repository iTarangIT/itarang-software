# iTarang Dealer Battery Buyback Portal (peakAmp) — Development BRD v1.0

Engineering companion to Business BRD v2.0. Audience: Aditya (build), Kartik (TL review), Chirag (GST gates).
Consolidates: Draft 1.0 spec (18 modules) + TL review updates U1–U13 + prototype review changes P1–P7 + prototype learnings.
Stack: Next.js/TypeScript · PostgreSQL (Drizzle, AWS RDS) · BullMQ/Redis · S3 · Digio · Razorpay · Meta WhatsApp Cloud API.

## 1. System overview & build principle

iTarang is a back-to-back principal trader in end-of-life batteries: buy from dealers (dealer leg), sell to scrap vendors (vendor leg), margin locked at agreement. The portal is the system of record for both negotiations, all documents, both money movements, and the compliance chain.

**Build principle (non-negotiable): one vertical slice first.** A single request must travel the entire state machine — dealer submit to vendor payment — before any module is widened. Every screen is a view on the deal state machine; every action is a transition on it.

**Reuse before build:** auth/roles, entity & KYC store, Digio eSign, Razorpay checkout, S3 presigned upload, invoice numbering, WhatsApp sender + templates already exist in the CRM. See §8.

### End-to-end flow

```
Dealer: create request (single page)
  -> add battery SKU lines (variant auto-fills specs + est. price; qty N -> Unit 1..N)
  -> provenance + photos + pickup address -> SUBMIT
Admin review queue
  -> Request Info (specific units) -> dealer uploads proof, resubmits -> back to review
  -> Approve -> item-wise negotiation (separate price per SKU)
  -> dealer counters/accepts -> admin sends FINAL OFFER (itemized, versioned) -> dealer YES/NO
Admin adds margin per SKU (dealer never sees) -> quotation PDF (no dealer identity)
  -> emailed to selected vendors -> vendor accepts / counters per SKU (recorded per thread)
  -> one AGREED, others LOST (below floor -> reopen dealer leg)
Vendor PO in -> iTarang PO out -> pickup per batch (variance check)
Dealer raises invoice (per-line prices) -> admin approves (per-line match)
  -> iTarang invoices vendor
Record TXN-{deal}-D (payout, OUT) + TXN-{deal}-V (receipt, IN) -> SETTLED -> CLOSED
Dashboard & audit reconciliation (margin from locked values only)
```

## 2. Deal state machine (single source of truth)

Persist status as one enum on the deal; never scattered booleans. All actions gated by state; illegal transitions rejected **server-side**.

| Stage | States | Gating rules |
|---|---|---|
| Intake | DRAFT → SUBMITTED → UNDER_REVIEW | Submit requires ≥1 line, ≥5 photos/line, provenance complete |
| Review | INFO_REQUESTED ⇄ UNDER_REVIEW · NEGOTIATING · FINAL_OFFER_SENT | Four review actions ONLY in SUBMITTED/UNDER_REVIEW; ghosted+tooltip after |
| Dealer lock | DEALER_ACCEPTED (provisional) → MARGIN_SET | Reopen allowed (versioned+notified) any time BEFORE vendor agreement; never after |
| Vendor leg | VENDOR_ROUTED → VENDOR_NEGOTIATING → VENDOR_AGREED | One AGREED auto-closes others LOST; below floor → DEALER_REOPENED |
| Fulfilment | PO_EXCHANGED → PICKUP_SCHEDULED → PICKED_UP | POs impossible before VENDOR_AGREED |
| Money | INVOICE_RAISED → INVOICE_APPROVED → SETTLED → CLOSED | Approval = per-line price match; SETTLED = both sub-transactions closed |
| Terminal | REJECTED · CANCELLED · threads: SENT/COUNTERED/AGREED/LOST | Cancel closes open threads + notifies |

Implement the machine as a **pure function** with a golden fixture table of `(state, action, role) → nextState | rejected` (same pattern as the EMI-calculator fixtures).

## 3. Data model (Drizzle / PostgreSQL)

Rule: **pricing never lives on the request** — it lives on lines and their locked snapshots (P5).

| Table | Key columns / notes |
|---|---|
| catalog_variants | type, chemistry, voltage, ah — UNIQUE(type,voltage,ah); unit_price; est_buyback_price_working; est_buyback_price_dead; price_book_version; active. Every V+Ah combo is a separate variant (P1) |
| business_entity_roles | entity_id, role BATTERY_DEALER\|SCRAP_SELLER\|SCRAP_VENDOR, status, agreement_id |
| scrap_vendors | entity_id, categories jsonb, regions, payment_terms, credit_limit |
| agreements | entity_id, role, digio_doc_id, firm_registration_no, status, signed_at (U12) |
| buyback_requests | dealer_entity_id, source_channel WEB\|WHATSAPP\|CSV, status, created_by |
| buyback_batches | request_id, pickup_address_id, status |
| buyback_lines | batch_id, variant_id, quantity, condition WORKING\|DEAD, measured_voltage, expected_price_per_unit, price_book_version_at_create |
| buyback_units | line_id, unit_no 1..N, status — auto-generated from quantity (P3) |
| photos | line_id, unit_id nullable, s3_key_original, s3_key_display, phash, exif jsonb, taken_at — min 5/line at submit |
| provenance_records | scope LINE\|UNIT, line_id/unit_id, source_type PREV_OWNER_DOCS\|DEALER_STOCK, prev_owner_name, prev_owner_phone, vehicle_no, rc_number, id_proof_type, id_proof_s3, payment_proof_ref? — single owner identity (P2); bulk-apply copies across selected units |
| info_requests | request_id, target_line_ids[], target_unit_ids[], checklist jsonb, note, resolved_at — unit-targeted (P4) |
| buyback_deals | request_id, status, floor_total, locked_at |
| negotiation_rounds | deal_id, leg DEALER\|VENDOR, counterparty_id, round_no, offered_by, note, created_at |
| negotiation_round_lines | round_id, line_id, offered_price_per_unit — every offer itemized per SKU (P5) |
| final_offers | deal_id, version_no, status SENT\|ACCEPTED\|DECLINED, sent_at, responded_at — reopen bumps version (U5) |
| final_offer_lines | final_offer_id, line_id, price_per_unit |
| deal_line_locks | deal_id, line_id, dealer_price, margin_value, margin_mode FLAT\|PCT, vendor_ask, vendor_price — immutable per-SKU snapshot all documents & reports read from |
| vendor_threads | deal_id, vendor_id, status SENT\|COUNTERED\|AGREED\|LOST, quotation_pdf_s3, email_message_id, sent_at (U6) |
| vendor_thread_lines | thread_id, line_id, ask_price, counter_price, agreed_price (P5/P7) |
| purchase_orders | deal_id, leg, direction ISSUED\|RECEIVED, number, pdf_s3, status GENERATED\|SENT\|ACKNOWLEDGED (U7) |
| invoices + invoice_lines | deal_id, leg, raised_by_party, number, pdf_s3, status; approved_by/at, per-line matched flags, returned_reason (U8) — approval compares invoice_lines to deal_line_locks |
| settlement_transactions | group_txn_id, leg_sub_id -D\|-V, direction OUT\|IN, method MANUAL\|STATEMENT\|API, txn_ref, amount, txn_date, proof_s3, recorded_by, closed_at (U9/U10) |
| pickups | batch_id, scope ORDER\|BATCH\|LINE, scheduled_at, address, contact, eway_bill_no, weighbridge_slip_s3, actual_counts jsonb, variance_flag, dealer_ack_at (U11) |
| notifications | event_type, recipient_party, channel WHATSAPP\|EMAIL\|PORTAL, payload jsonb, sent_at, delivery_status (U4) |
| activity_log | request_id, actor_id, role, action, before jsonb, after jsonb, created_at — INSERT-only (revoke UPDATE/DELETE) |

## 4. Module specifications M01–M24 (with acceptance criteria)

- **M01 Dealer dashboard** — KPI cards, recent requests, bell; entity-scoped. AC: another dealer's request → 404 via UI and API.
- **M02 Buyback request, single page** — table intake, no wizard; variant auto-fills voltage/Ah + est. price (P1), dealer edits only measured voltage; qty N → Unit 1..N (P3); "+ Add Battery" = multiple SKUs; draft autosave; background presigned photo uploads. Dev note: ONE shared battery-line summary formatter component (spec label + condition chip + counts) used everywhere — the prototype's `[object Object]` bug came from per-screen templates. AC: 2-SKU request submits in <2 min with bulk provenance.
- **M03 Image management** — 5–6 photos/line min (submit blocked <5); original + display copy; phash on ingest, nightly dedup flags; unit tagging optional; admin per-line zoom lightbox. AC: duplicate phash across dealers raises a flag.
- **M04 Provenance** — per line (default) or per unit; source toggle PREV_OWNER_DOCS (previous owner name — usually the driver — phone, vehicle/RC, ID proof, optional purchase proof) or DEALER_OWN_STOCK (P2); bulk apply with per-unit override. AC: submit blocked if any line lacks provenance.
- **M05 Pickup hierarchy** — address at order/batch/line (U11); pickup jobs per batch: schedule, contact, e-way no., weighbridge slip, actual counts, variance flag; dealer WhatsApp ack on variance before payout. AC: two batches, two cities, independent.
- **M06 Admin review, four actions** — Accept · Reject(reason) · Negotiate · Request Info (select target lines/units first, then checklist + note → INFO_REQUESTED; dealer banner names exactly those batteries) (P4/U3). State-gated; server rejects regardless of UI. AC: info request on Unit 2 shows only Unit 2 in dealer banner.
- **M07 Negotiation engine (per SKU)** — every counter itemized per line, never lump sum (P5); rounds logged (actor, per-line amounts, ts); final offer = per-line table, ONE overall Accept/Decline (U5); reopen versioned + notified, only before VENDOR_AGREED. AC: reopen after vendor agreement rejected server-side.
- **M08 Margin engine (per line)** — flat ₹/unit or %, resolved rupee stored in deal_line_locks; floor blocks routing below breakeven. AC: margin fields absent from dealer-role payloads.
- **M09 Vendor routing & quotation** — multi-select vendors; quotation PDF: per-SKU asks + condition + photos, NO dealer identity; emailed per vendor (U6); log message_id, BCC system mailbox. AC: PDF contains no dealer name/phone/GST.
- **M10 Vendor negotiation** — record per-SKU responses per thread; first AGREED wins, others auto-LOST atomically (+courteous close email); below floor → "Reopen dealer leg".
- **M11 PO flow** — buyer initiates: vendor PO → iTarang (record + acknowledge); iTarang PO → dealer from deal_line_locks (U7). AC: PO impossible before VENDOR_AGREED.
- **M12 Invoice flow** — dealer raises on portal, pre-filled per-line locked prices; approval compares line-by-line to locks; mismatch → return with reason (U8/P5); iTarang invoices vendor. AC: one edited line blocks approval even if total matches.
- **M13 Payments & settlement** — group TXN-{deal} + subs -D (OUT) / -V (IN) (U10); methods in build order: MANUAL (txn id, amount, date, mandatory proof) → STATEMENT reconcile → bank/Razorpay API (U9). Both closed → SETTLED → CLOSED. AC: manual settlement without proof rejected.
- **M14 Transaction history** — flat ledger, filters, CSV export, IN/OUT/net totals. AC: ledger net for CLOSED deals == dashboard Total Margin Earned (reconciliation invariant).
- **M15 Document center** — per deal: quotation PDF, both POs, both invoices + approval state, proofs; direction matrix. AC: every CLOSED deal has the full set.
- **M16 Battery catalog (variants)** — CRUD; every V+Ah a separate entry with Working/Dead bands; versioned price books; weekly review nudge. AC: catalog edits never change open requests' reference price.
- **M17 Dealer onboarding** — existing dealer/same firm: KYC read-only + firm registration no. + agreement eSign only (U12); new dealer: full form → Razorpay fee → agreement. Full flow details in the separate onboarding discussion (P6).
- **M18 Scrap vendor onboarding** — admin-initiated: GST, PAN, agreement, categories, regions, terms. AC: unonboarded vendor unselectable for routing.
- **M19 Agreement module** — Digio eSign for dealers AND vendors; signed webhook → role activation; non-circumvention clause = Chirag item.
- **M20 Notification engine** — every state change/action emits exactly one event (U4); WhatsApp (dealers), email (vendors), portal (admin); idempotency keys. AC: no silent transitions.
- **M21 Audit trail** — activity_log written in the same transaction as every change; INSERT-only; before→after for prices; read-only tab. AC: a CLOSED deal's log replays its full history, no gaps.
- **M22 Dashboards & reports** — margin from deal_line_locks only; funnel + aging; dealer-wise/vendor-wise; reports (margin, dealer perf, vendor perf incl. payment days & bid-to-win, pipeline aging) filterable + export. AC: no report reads live catalog prices.
- **M23 Search & permissions** — global search (request ID, dealer, vendor, RC, TXN) scoped by role; API-layer redaction: dealer payloads structurally exclude margin/vendor fields; vendor payloads exclude dealer identity + margin split; contract tests release-blocking. AC: keys absent, not nulled.
- **M24 WhatsApp intake (future) & vendor portal (V1.1)** — WhatsApp: Meta Cloud API + Gemini extraction → same request object, source badge. Vendor portal V1.1: vendor dashboard (New Quotations, Active Bids, Won, Lost, Payments Due) (P7), itemized per-SKU quotation inbox + response table, PO upload, orders & payments — masked like the email PDF; every vendor response notifies admin. **v1 ships WITHOUT vendor login** — email PDF + admin recording is the shipped path.

## 5. API surface (v1)

Dealer: `POST /buyback/requests` · `POST /:id/batches` · `POST /batches/:id/lines` (variant_id, qty → units auto) · `POST /photos/presign` · `POST /:id/provenance` (scope, bulk) · `POST /:id/submit` · `GET /my/requests` · `POST /final-offers/:id/respond {ACCEPT|DECLINE}` · `POST /invoices` (per-line prefilled)

Admin: `GET /admin/buyback/queue` · `GET /:id` · `POST /:id/decision {accept|reject|negotiate(lines[])|request_info(targets,checklist)}` · `POST /:id/final-offer (lines[])` · `POST /:id/reopen` · `POST /:id/margin (per line)` · `POST /:id/route {vendor_ids}` · `POST /threads/:id/record (per-line)` · `POST /:id/lock` · `POST /:id/po/:leg` · `POST /invoices/:id/approve|return` · `POST /settlements` · pickups CRUD + `/:id/complete` · catalog CRUD · vendors CRUD

Webhooks: WhatsApp inbound → intake · Digio signed → activation · email events → thread log · payment updates → settlement.

Every mutating endpoint: validates state transition server-side, writes activity_log in-transaction, emits one notification event.

## 6. Security & NFRs

API-layer redaction with role-scoped serializers (contract tests release-blocking) · activity_log INSERT-only at DB-grant level · S3 versioning on originals/proofs · presigned + background uploads · queue index (status, created_at) · notifications via BullMQ, never inline · quote expiry (72h default) + per-dealer exposure caps · BWM 2022 fields on pickup (e-way, weighbridge) · GST/HSN/reverse-charge = Chirag gate before first live deal.

## 7. Background jobs (BullMQ)

photo-hash-dedup · whatsapp-intake-extract (Gemini) · quotation-pdf + email-dispatch (message IDs) · po/invoice-pdf · quote-expiry · payment-reminders (both legs) · pickup-day-checklist · daily margin rollup + ledger-vs-dashboard reconciliation alert · catalog price-review nudge · notification-dispatch with retry/backoff.

## 8. Reuse vs new

REUSE: auth/roles · entity & KYC store (add business_entity_roles layer) · Digio eSign · Razorpay checkout · S3 presign · invoice numbering (extend per leg) · WhatsApp sender + templates · Gemini extraction.
NEW: state machine · variants/lines/units/locks · negotiation + threads · settlements · activity log · quotation/PO/invoice PDF generation + email dispatch (needs a transactional email provider — SES recommended; SPF/DKIM/DMARC + production access in Sprint 0).

## 9. Sprint plan

| Sprint | Scope | Exit criteria |
|---|---|---|
| 0 | This BRD as structure doc; schema PR (§3 — variants, lines, units, locks first); reuse confirmation; external approvals ticket (Meta templates, SES production, Digio templates) | Kartik schema sign-off; Chirag briefed on GST |
| 1 — spine | M02, M06, M07, M08, M20 skeleton, M21, M01/M22 basics | One request: submit → info loop → per-SKU final offer → accepted → margin locked; every step notified + logged |
| 2 — sell side & money | M09, M10, M11, M12, M13 (manual), M14 | Full deal end to end; ledger reconciles; E2E Plan Part A passes |
| 3 — quality & compliance | M03, M04 (unit-level), M05, M16, statement reconcile | Parts B & D pass; BWM completeness on a closed deal |
| 4 — trust & access | M17–M19, M23 | Part C API-layer permission tests pass (release blocker) |
| 5 — reach | M24, reports/exports, API settlement capture | WhatsApp request in same pipeline; vendor portal masked |

**Go-live gate:** the ₹40–60k real-money pilot run entirely through the portal; Part D reconciliation must hold.

## 10. Open items

GST/HSN/reverse-charge (Chirag, gates first live deal) · onboarding details (separate discussion, P6) · payout execution deferred (record, don't execute) · brand hex tokens · non-circumvention clause language.

## Appendix A — Change traceability

U1→M02 · U2→M04 · U3→M06 · U4→M20 · U5→M07/M08 · U6→M09 · U7→M11/M12 · U8→M12 · U9/U10→M13/M14 · U11→M05 · U12→M17/M19 · P1→M02/M16 · P2→M04 · P3→M02/M03/M04/§3 · P4→M06 · P5→M07–M09/M12/§3 · P6→M17/§10 · P7→M24 · Prototype learnings: state gating→M06, Razorpay onboarding→M17, audit→M21, ledger→M14, API permissions→M23, global search→M23, shared line formatter→M02.
