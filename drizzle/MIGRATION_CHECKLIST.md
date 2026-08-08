# Migration Checklist

There is **no automatic migration runner** in this project. Each `E-<n>_*.sql` file
in `drizzle/` must be applied **by hand to every database**, because `DATABASE_URL`
points at different AWS RDS instances per environment and they drift independently.
(Migrations silently stopped applying on prod around ~E-145 — this checklist exists
to stop that recurring.)

## Environments

| Env | DB host (RDS) | Notes |
|-----|---------------|-------|
| local / dev | `database-2.…ap-south-1.rds.amazonaws.com/postgres` | what `localhost:3000` uses via `.env.local` |
| dev alt | `database-1.…` | `DATABASE_URL` sometimes flips here — apply to both |
| sandbox | (Hostinger-served app → its RDS) | |
| production | (prod RDS) | apply on deploy |

## How to apply one migration

All migrations are additive + idempotent (`ADD COLUMN IF NOT EXISTS`, etc.), so
re-running is a safe no-op. **Do not use `npm run db:push`** against any shared DB.

Paste the file's SQL into your DB client (DBeaver / psql / Supabase SQL editor), OR
(point `.env.local`'s `DATABASE_URL` at the target env first):

```bash
node -e "require('dotenv').config({path:'.env.local'}); const fs=require('fs'); const {Client}=require('pg'); const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}}); c.connect().then(()=>c.query(fs.readFileSync('drizzle/E-176_consent_signer_name_score.sql','utf8'))).then(()=>{console.log('applied'); return c.end();}).catch(e=>{console.error(e.message);process.exit(1);})"
```

## Legend

- ☐ = unverified / not confirmed applied in that env
- ✅ = confirmed present (checked via `information_schema` / `\d <table>`)

**Backfill note:** every row below was seeded as ☐ because actual per-env state was
never tracked. Migrations ≤ E-174 are *assumed* applied on dev historically but are
**unverified** — when you confirm one (or hit a "relation/column does not exist"
error and fix it), tick the box so the record becomes real over time. Prod is the
least trustworthy column (drift began ~E-145).

## Migrations

| Migration | What it adds | local (db-2) | db-1 | sandbox | prod |
|-----------|--------------|:---:|:---:|:---:|:---:|
| E-002_nbfc_portal_credentials | nbfc portal credentials | ☐ | ☐ | ☐ | ☐ |
| E-012_dealer_nbfc_assignments | dealer nbfc assignments | ☐ | ☐ | ☐ | ☐ |
| E-026_loan_sanctions_nbfc_lifecycle | loan sanctions nbfc lifecycle | ☐ | ☐ | ☐ | ☐ |
| E-026B_nbfc_tenant_bridge | nbfc tenant bridge | ☐ | ☐ | ☐ | ☐ |
| E-027_telemetry_ingestion_log | telemetry ingestion log | ☐ | ☐ | ☐ | ☐ |
| E-029_emi_schedules | emi schedules | ☐ | ☐ | ☐ | ☐ |
| E-030_pci_nightly_computation | pci nightly computation | ☐ | ☐ | ☐ | ☐ |
| E-046_telemetry_ingestion | telemetry ingestion | ☐ | ☐ | ☐ | ☐ |
| E-049_telemetry_alerts | telemetry alerts | ☐ | ☐ | ☐ | ☐ |
| E-050_telemetry_schema_apply | telemetry schema apply | ☐ | ☐ | ☐ | ☐ |
| E-065_ecosystem_metrics_cache | ecosystem metrics cache | ☐ | ☐ | ☐ | ☐ |
| E-066_nbfc_anomaly_flags | nbfc anomaly flags | ☐ | ☐ | ☐ | ☐ |
| E-067_nbfc_risk_rules | nbfc risk rules | ☐ | ☐ | ☐ | ☐ |
| E-080_compliance_screen | compliance screen | ☐ | ☐ | ☐ | ☐ |
| E-082_dual_approval | dual approval | ☐ | ☐ | ☐ | ☐ |
| E-083_nbfc_immobilisation_actions | nbfc immobilisation actions | ☐ | ☐ | ☐ | ☐ |
| E-084_loan_restructures | loan restructures | ☐ | ☐ | ☐ | ☐ |
| E-085_risk_rule_thresholds | risk rule thresholds | ☐ | ☐ | ☐ | ☐ |
| E-089_pii_access_grants | pii access grants | ☐ | ☐ | ☐ | ☐ |
| E-090_nbfc_consent_dpdpa | nbfc consent dpdpa | ☐ | ☐ | ☐ | ☐ |
| E-092_score_explainability | score explainability | ☐ | ☐ | ☐ | ☐ |
| E-093_auction_auto_bids | auction auto bids | ☐ | ☐ | ☐ | ☐ |
| E-103_product_selections_model_number_rename | product selections model number rename | ☐ | ☐ | ☐ | ☐ |
| E-104_scraper_runs_skipped_invalid_phone | scraper runs skipped invalid phone | ☐ | ☐ | ☐ | ☐ |
| E-105_dealer_leads_provider_column | dealer leads provider column | ☐ | ☐ | ☐ | ☐ |
| E-106_dealer_leads_region_hierarchy | dealer leads region hierarchy | ☐ | ☐ | ☐ | ☐ |
| E-106_dealers_backfill_from_approved_applications | dealers backfill from approved applications | ☐ | ☐ | ☐ | ☐ |
| E-106_expense_ai_fields | expense ai fields | ☐ | ☐ | ☐ | ☐ |
| E-107_backfill_dealer_leads_city_from_raw_address | backfill dealer leads city from raw address | ☐ | ☐ | ☐ | ☐ |
| E-107_nbfc_docs_verified | nbfc docs verified | ☐ | ☐ | ☐ | ☐ |
| E-108_location_reference_tables | location reference tables | ☐ | ☐ | ☐ | ☐ |
| E-108_nbfc_created_by_auth | nbfc created by auth | ☐ | ☐ | ☐ | ☐ |
| E-109_dialer_campaigns | dialer campaigns | ☐ | ☐ | ☐ | ☐ |
| E-109_nbfc_lsp_agreement_signers | nbfc lsp agreement signers | ☐ | ☐ | ☐ | ☐ |
| E-110_call_costs | call costs | ☐ | ☐ | ☐ | ☐ |
| E-110_nbfc_lsp_agreement_template_url | nbfc lsp agreement template url | ☐ | ☐ | ☐ | ☐ |
| E-111_drop_ai_call_logs_lead_id_fkey | drop ai call logs lead id fkey | ☐ | ☐ | ☐ | ☐ |
| E-111_nbfc_correction_rounds | nbfc correction rounds | ☐ | ☐ | ☐ | ☐ |
| E-112_dealer_leads_part0_columns | dealer leads part0 columns | ☐ | ☐ | ☐ | ☐ |
| E-112_nbfc_lsp_agreement_signer_status | nbfc lsp agreement signer status | ☐ | ☐ | ☐ | ☐ |
| E-113_lead_touchpoints | lead touchpoints | ☐ | ☐ | ☐ | ☐ |
| E-113_loan_products_scheme_highlights | loan products scheme highlights | ☐ | ☐ | ☐ | ☐ |
| E-114_lead_visits | lead visits | ☐ | ☐ | ☐ | ☐ |
| E-114_loan_products_active_locations | loan products active locations | ☐ | ☐ | ☐ | ☐ |
| E-115_lead_escalations | lead escalations | ☐ | ☐ | ☐ | ☐ |
| E-115_loan_products_cibil_range | loan products cibil range | ☐ | ☐ | ☐ | ☐ |
| E-116_dealer_lead_commercials | dealer lead commercials | ☐ | ☐ | ☐ | ☐ |
| E-116_lead_products | lead products | ☐ | ☐ | ☐ | ☐ |
| E-117_dealer_lead_status_history | dealer lead status history | ☐ | ☐ | ☐ | ☐ |
| E-117_widen_score_loan_refs | widen score loan refs | ☐ | ☐ | ☐ | ☐ |
| E-118_asm_territories | asm territories | ☐ | ☐ | ☐ | ☐ |
| E-118_nbfc_buyback_requests | nbfc buyback requests | ☐ | ☐ | ☐ | ☐ |
| E-119_nbfc_battery_evaluations | nbfc battery evaluations | ☐ | ☐ | ☐ | ☐ |
| E-119_upload_batches | upload batches | ☐ | ☐ | ☐ | ☐ |
| E-120_assignment_config | assignment config | ☐ | ☐ | ☐ | ☐ |
| E-121_holiday_calendar | holiday calendar | ☐ | ☐ | ☐ | ☐ |
| E-122_duplicate_merge_requests | duplicate merge requests | ☐ | ☐ | ☐ | ☐ |
| E-123_interest_level_overrides | interest level overrides | ☐ | ☐ | ☐ | ☐ |
| E-124_user_preferences | user preferences | ☐ | ☐ | ☐ | ☐ |
| E-125_cost_currency_default_inr | cost currency default inr | ☐ | ☐ | ☐ | ☐ |
| E-126_dealer_leads_source_column | dealer leads source column | ☐ | ☐ | ☐ | ☐ |
| E-127_onboarding_application_part0_columns | onboarding application part0 columns | ☐ | ☐ | ☐ | ☐ |
| E-128_dealer_lead_commercials_product_lines | dealer lead commercials product lines | ☐ | ☐ | ☐ | ☐ |
| E-129_seed_auction_lots_demo | seed auction lots demo | ☐ | ☐ | ☐ | ☐ |
| E-130_addendum_foundation | addendum foundation | ☐ | ☐ | ☐ | ☐ |
| E-131_nbfc_lead_assignments | nbfc lead assignments | ☐ | ☐ | ☐ | ☐ |
| E-132_zoho_finance_and_expenses | zoho finance and expenses | ☐ | ☐ | ☐ | ☐ |
| E-133_nbfc_service_config_and_rbac | nbfc service config and rbac | ☐ | ☐ | ☐ | ☐ |
| E-134_enach_mandates | enach mandates | ☐ | ☐ | ☐ | ☐ |
| E-135_video_kyc | video kyc | ☐ | ☐ | ☐ | ☐ |
| E-136_field_investigations | field investigations | ☐ | ☐ | ☐ | ☐ |
| E-137_nbfc_wallet_charging | nbfc wallet charging | ☐ | ☐ | ☐ | ☐ |
| E-138_manual_handoff | manual handoff | ☐ | ☐ | ☐ | ☐ |
| E-139_backfill_nbfc_tenant_binding | backfill nbfc tenant binding | ☐ | ☐ | ☐ | ☐ |
| E-140_backfill_assigned_lead_status | backfill assigned lead status | ☐ | ☐ | ☐ | ☐ |
| E-140_nbfc_financing_offers | nbfc financing offers | ☐ | ☐ | ☐ | ☐ |
| E-141_financing_dead_end | financing dead end | ☐ | ☐ | ☐ | ☐ |
| E-141_sync_prod_to_sandbox | sync prod to sandbox | ☐ | ☐ | ☐ | ☐ |
| E-142_nbfc_users_notification_prefs | nbfc users notification prefs | ☐ | ☐ | ☐ | ☐ |
| E-143_nbfc_users_role_normalise | nbfc users role normalise | ☐ | ☐ | ☐ | ☐ |
| E-144_nbfc_loans_drop_loan_application_fk | nbfc loans drop loan application fk | ☐ | ☐ | ☐ | ☐ |
| E-145_enach_razorpay_fields | enach razorpay fields | ☐ | ☐ | ☐ | ☐ |
| E-146_nbfc_loan_agreements | nbfc loan agreements | ☐ | ☐ | ☐ | ☐ |
| E-147_nbfc_service_config_enach_handoff_itarang_razorpay | nbfc service config enach handoff itarang razorpay | ☐ | ☐ | ☐ | ☐ |
| E-148_field_investigation_full_spec | field investigation full spec | ☐ | ☐ | ☐ | ☐ |
| E-149_nbfc_documents_storage_bucket | nbfc documents storage bucket | ☐ | ☐ | ☐ | ☐ |
| E-150_field_investigations_status_widen | field investigations status widen | ☐ | ☐ | ☐ | ☐ |
| E-151_nbfc_loan_agreement_source_doc | nbfc loan agreement source doc | ☐ | ☐ | ☐ | ☐ |
| E-152_vkyc_passive_link | vkyc passive link | ☐ | ☐ | ☐ | ☐ |
| E-153_vkyc_mode_allow_passive | vkyc mode allow passive | ☐ | ☐ | ☐ | ☐ |
| E-154_vkyc_session_video_url | vkyc session video url | ☐ | ☐ | ☐ | ☐ |
| E-155_field_investigations_status_check_fix | field investigations status check fix | ☐ | ☐ | ☐ | ☐ |
| E-156_field_investigations_partial_unique_index_fix | field investigations partial unique index fix | ☐ | ☐ | ☐ | ☐ |
| E-157_repair_orphaned_field_investigations | repair orphaned field investigations | ☐ | ☐ | ☐ | ☐ |
| E-158_intent_scoring_audit | intent scoring audit | ☐ | ☐ | ☐ | ☐ |
| E-159_intent_score_feedback | intent score feedback | ☐ | ☐ | ☐ | ☐ |
| E-160_nbfc_wallet_funds_provider | nbfc wallet funds provider | ☐ | ☐ | ☐ | ☐ |
| E-161_financing_offer_ceo_approval | financing offer ceo approval | ☐ | ☐ | ☐ | ☐ |
| E-162_nbfc_custom_rbac | nbfc custom rbac | ☐ | ☐ | ☐ | ☐ |
| E-163_nbfc_notification_channels | nbfc notification channels | ☐ | ☐ | ☐ | ☐ |
| E-164_dealer_onboarding_draft_step | dealer onboarding draft step | ☐ | ☐ | ☐ | ☐ |
| E-165_nbfc_byo_provider_handoff | nbfc byo provider handoff | ☐ | ✅ | ☐ | ☐ |
| E-166_nbfc_provider_credentials | nbfc provider credentials | ☐ | ✅ | ☐ | ☐ |
| E-167_whatsapp_onboarding | whatsapp onboarding | ☐ | ☐ | ☐ | ☐ |
| E-168_intent_qualification_band | intent qualification band | ☐ | ☐ | ☐ | ☐ |
| E-169_campaign_dropped_empty_not_failed | campaign dropped empty not failed | ☐ | ☐ | ☐ | ☐ |
| E-170_backfill_storage_urls_to_files_proxy | backfill storage urls to files proxy | ☐ | ☐ | ☐ | ☐ |
| E-170_discord_bot_service_user | discord bot service user | ☐ | ☐ | ☐ | ☐ |
| E-170_whatsapp_dealer_sessions | whatsapp dealer sessions | ☐ | ☐ | ☐ | ☐ |
| E-171_emi_tracker_columns | emi tracker columns | ☐ | ☐ | ☐ | ☐ |
| E-171_zoho_invoices_organization_id | zoho invoices organization id | ☐ | ☐ | ☐ | ☐ |
| E-172_emi_payment_attempts | emi payment attempts | ☐ | ☐ | ☐ | ☐ |
| E-172_expense_invoice_number_file_name | expense invoice number file name | ☐ | ☐ | ☐ | ☐ |
| E-173_emi_partial_payments | emi partial payments | ☐ | ☐ | ☐ | ☐ |
| E-174_leads_source_channel | leads source channel | ☐ | ☐ | ☐ | ☐ |
| E-174_zoho_invoice_payment_reference | zoho invoice payment reference | ☐ | ☐ | ☐ | ☐ |
| E-175_dealer_owner_aadhaar | dealer_onboarding_applications.owner_aadhaar_no + owner_aadhaar_verified (dealer agreement Aadhaar match) | ✅ | ✅ | ☐ | ☐ |
| E-176_consent_signer_name_score | consent_records.signer_name_match_score (Aadhaar e-sign name-match signal) | ✅ | ✅ | ☐ | ☐ |
| E-177_loan_calculator | dealer loan calculator: calc_* tables (nbfcs/schemes/model_caps/component_prices/coverage/settings/config_versions/audit_log/leads) + guard indexes & checks | ✅ | ✅ | ☐ | ☐ |
| E-178_calc_otp_search_history | calc_otp_verifications + calc_leads otp/wa columns (OTP-gated calculator, WhatsApp results, admin search history) | ✅ | ✅ | ☐ | ☐ |
| E-179_lead_registry | lead_registry — central capture of every new lead (dealer/customer/oem/nbfc, web+whatsapp) with name/phone + source link | ✅ | ✅ | ☐ | ☐ |
| E-180_consent_otp_verifications | consent_otp_verifications + consent_records otp_verification_id/otp_verified_at (OTP-based customer consent, replaces Digio Aadhaar e-sign) | ✅ | ✅ | ☐ | ☐ |
| E-181_nbfc_emi_tracker_overrides | nbfc_emi_tracker_overrides — per-loan display overrides for the EMI Tracker table (borrower/serial/emi/next_due/last_paid/progress/status/dpd/mandate/next_auto_debit) | ✅ | ✅ | ☐ | ☐ |
| E-182_emi_tracker_financier | nbfc_emi_tracker_overrides.financier — free-text financier label shown in a new Finance column on the EMI Tracker | ✅ | ✅ | ☐ | ☐ |
| E-183_emi_tracker_standalone | nbfc_emi_tracker_overrides.is_standalone + loan_application_id made nullable + partial unique index on (tenant, lower(vehicleno)) WHERE is_standalone — force-import bulk-upload rows with no matching loan as display-only tracker entries | ✅ | ✅ | ☐ | ☐ |
| E-184_device_battery_map_location | device_battery_map.state + city (Intellicar Fleet Overview State/City filters) | ✅ | ✅ | ✅ | ✅ |
| E-185_risk_card_verdict_source | risk_card_runs.verdict_source (hand_coded/sandbox/none/legacy_llm) + backfill; severity vocabulary widened to include inconclusive/error so a failed test stops rendering as a green OK card | ✅ | ✅ | ☐ | ☐ |
| E-186_risk_hypothesis_text_matches_code | Rewrites the 5 hand-coded risk_hypotheses descriptions so the text shown to operators matches the test that runs (geo-shift said "100 km from onboarding centroid" but checked an India bounding box) and stops hard-coding threshold values now governed by nbfc_risk_rules | ✅ | ☐ | ☐ | ☐ |
| E-187_risk_runs | risk_runs table (one row per risk-engine invocation) + risk_card_runs.run_id. Partial unique index (tenant_id) WHERE status='running' is the concurrency lock; the table is also the freshness source for the Risk page | ✅ | ✅ | ☐ | ☐ |
| E-188_risk_hypothesis_promotion | risk_hypotheses.promoted_at/promoted_by/retire_reason. An unvetted llm-v1 hypothesis is capped at severity=warn and cannot raise a High Alert until a human promotes it; hand-coded rows backfilled as promoted. Enables catalogue reuse + retirement instead of unbounded growth | ☐ | ✅ | ☐ | ☐ |
| E-189_inventory_transfers_canonical_ids | Rebuilds inventory_transfers on canonical id types (varchar(64) PK, varchar(255) dealer ids → accounts.id, uuid actor ids → users.id). This DB still had the pre-0038 integer-PK/integer-FK/rejected_* design, so every transfer read blew up with 22P02 "invalid input syntax for type integer: ACC-…". Supersedes 0038; guarded — drops only when the stale schema is present AND empty, else RAISEs | ✅ | ☐ | ☐ | ☐ |
| E-185_buyback_core | peakAmp Battery Buyback Portal core schema (BRD §3) — buyback_deal_status enum (all 21 states) + catalog_variants, business_entity_roles, buyback_pickup_addresses, buyback_requests/batches/lines/units, buyback_photos, provenance_records, info_requests, buyback_deals, negotiation_rounds(+_lines), final_offers(+_lines), deal_line_locks, buyback_activity_log (INSERT-only trigger), buyback_notification_events | ☐ | ✅ | ✅ | ☐ |
| E-186_buyback_vendor_leg | peakAmp vendor leg & fulfilment (M09–M11 + minimal M05) — scrap_vendors, vendor_threads (partial UNIQUE: one AGREED vendor per deal), vendor_thread_lines, purchase_orders(+_lines, tax cols modelled not ruled), pickups, buyback_po_no_seq; buyback_notification_events gains attempts/next_attempt_at/recipient_ref/attachment_s3_key for dispatch; deal_line_locks becomes FILL-ONCE via trigger (only vendor_price, only once). **Apply AFTER E-185.** | ☐ | ✅ | ✅ | ☐ |
| E-187_buyback_money | peakAmp money leg (M12–M14) — invoices (partial UNIQUE: one LIVE invoice per deal+leg, RETURNED ones kept as evidence), invoice_lines (per-line `matched` verdict + tax cols), settlement_transactions (TXN-{n}-D OUT / -V IN; **CHECK constraint makes an unevidenced MANUAL payout impossible**; UNIQUE leg_sub_id so a dealer cannot be paid twice), buyback_invoice_no_seq. **Apply AFTER E-186.** | ☐ | ✅ | ✅ | ☐ |
| E-188_buyback_compliance_trust | peakAmp compliance & trust (Sprints 3–4) — agreements (Digio eSign, dealers AND vendors; one live per entity+role, declined ones kept); catalog_price_history + catalog_price_reviews (M16 versioned price books + weekly nudge); bank_statement_imports/_rows (M13 STATEMENT reconcile) + settlement_transactions.statement_row_id; buyback_photos dedup (phash index + dup_flag: **DUPLICATE_CROSS_DEALER is the fraud case**); pickups BWM gate (expected_counts, variance_ack_required — blocks payout until the dealer acknowledges a count variance). **Apply AFTER E-187.** | ☐ | ✅ | ✅ | ☐ |
| E-190_battery_spec_models | battery_spec_models catalog (per-model rated voltage/capacity + under/over-voltage, over-current, over-temp display thresholds) + device_battery_map.battery_model logical FK — Intellicar electrical analytics judge packs against their model spec (resolution: spec > app_settings > env > defaults); seeds placeholder LFP-51V-105AH | ☐ | ✅ | ✅ | ☐ |
| E-191_buyback_line_battery_specs | buyback_lines gains 11 nullable dealer-declared spec columns: brand, chemistry (NMC/LFP), form_factor (CELL/PRISMATIC/CYLINDRICAL), nominal_voltage, nominal_ampere, unit_weight_kg, warranty_cycles, functional_qty, non_functional_qty, iot_battery, iot_brand_name. Required subset enforced by the submit gate, not NOT NULL. **Apply AFTER E-185** (no-ops with a NOTICE where buyback tables don't exist — i.e. prod). | ☐ | ✅ | ✅ | ☐ |
| E-192_buyback_scale_indexes | Scale pack for 10K+ dealers: `CREATE EXTENSION pg_trgm` (needs rds_superuser — see file header); btree `buyback_requests(submitted_at NULLS LAST, created_at)` (the review queue's own sort), `buyback_activity_log(deal_id)`, partial `settlement_transactions(txn_date DESC) WHERE closed_at IS NOT NULL` (the ledger), FK indexes on `buyback_lines.variant_id`/`buyback_photos.unit_id`/`pickups.batch_id`; GIN trigram indexes for leading-wildcard admin/dealer search (M23) on `buyback_requests.request_no`, `provenance_records.{vehicle_no,rc_number,prev_owner_name}`, `settlement_transactions.{leg_sub_id,group_txn_id,txn_ref}`, and `accounts.{business_entity_name,gstin}` (accounts indexes in their OWN DO block since `accounts` exists on every env, unlike the buyback tables). **Apply AFTER E-185/186/187** for the buyback-table indexes; the `accounts` indexes apply everywhere including prod. Mirrored in `src/lib/db/schema.ts` so `db:push` users don't drop these. | ☐ | ✅ | ✅ | ☐ |
| E-193_buyback_gateway_payments | buyback_gateway_transactions — the ATTEMPT behind an online gateway money move (RazorpayX payout to a dealer, Razorpay Payment Link to a vendor); only a terminal PROCESSED/PAID mints a settlement_transactions row (method='API'). buyback_gateway_kind/buyback_gateway_status enums; partial UNIQUE `(deal_id, leg)` WHERE status is in-flight is the double-click race guard, partial UNIQUE `provider_ref` is the webhook idempotency guard. Also adds `accounts.bank_beneficiary_name` (RazorpayX beneficiary name, falls back to business_entity_name). **Apply AFTER E-185/E-187** — the gateway table no-ops with a NOTICE where those (or their enum types) don't exist yet (prod); the `accounts` column applies everywhere. Live since the R-round: the gateway routes/webhooks/ticker and the settlement in-flight guards all read this table. | ☐ | ✅ | ✅ | ☐ |
| E-194_buyback_intake_and_queue | Intake + review-queue corrections, all traced to db-1 evidence that 24 of the first 32 requests died in DRAFT and only 1 of 4 dealers ever reached the review queue: `buyback_pickup_addresses.owner_kind` (TEXT + CHECK DEALER\|VENDOR\|CUSTOMER, default DEALER — a vendor's collection point and a driver/customer's doorstep previously had nowhere to live; TEXT not enum, per E-191's reasoning in the same table family); btree `buyback_requests(submitted_at DESC NULLS LAST, created_at DESC)` backing the queue's new newest-first sort (NOT a duplicate of E-192's ASC index — reverse-scanning that one yields DESC NULLS **FIRST**, floating unsubmitted requests to the top; the ASC index stays for /reports and FIFO readers); plus two COMMENT rewrites on `buyback_lines` that E-191 left false — the submit gate no longer requires `iot_brand_name` (blank now resolves to 'Intellicar' in line-spec.ts) and the functional/non-functional split is a **ceiling, not an equality** (it rejected 5 working + 3 dead out of 10, i.e. a partially tested lot). **Apply AFTER E-185/E-191**; no-ops with a NOTICE where the buyback tables don't exist (prod). Mirrored in `src/lib/db/schema.ts` so `db:push` users don't drop the column/index. | ☐ | ✅ | ✅ | ☐ |
| E-196_buyback_proforma_invoice | The Proforma Invoice — the document that answers the vendor's PO (items 8/15, BRD step 3). A SEPARATE `proforma_invoices` + `proforma_invoice_lines` table on its own `buyback_proforma_no_seq` (PI-{n}-V, starts 1001), NOT an `invoices` row: `invoices` is the TAX slot (INV-{n}-V on the statutory buyback_invoice_no_seq — already at 5004, four numbers burnt by documents whose own template says they are not tax invoices). The existing vendor invoice stays put and becomes a real tax invoice the day GST is ruled (BRD §10). buyback_proforma_status enum (ISSUED/SUPERSEDED/CANCELLED — no RETURNED; nobody approves a proforma). po_id NOT NULL ('against' is the point — no PO, no PI). total server-derived from vendorReceipt(deal_line_locks), CHECK total>0. Partial UNIQUE (deal_id) WHERE status='ISSUED' — one live per deal, re-issue SUPERSEDES; verified 23505 on a second live, 23514 on a zero total. NO tax columns — a proforma is tax-exclusive. Also widens state-machine exchange_pos to the vendor role (E-196) so the vendor raises their OWN PO (lib/buyback/po.ts, one impl two callers), and the dealer activity filter moved to action-based so the PO exchange stays visible whoever uploads second. Whole file gated on to_regclass('buyback_deals') — no-ops on prod. Mirrored in schema.ts (partial index is SQL-only). Verified end-to-end on db-1 (rolled back): BB-1024 vendor PO -> PI-1001-V ₹24150 -> re-issue -> PI-1002-V, exactly one live. | ✅ | ✅ | ✅ | ☐ |
| E-197_buyback_owner_identity | Who the battery's previous owner is and how to pay them (item 4). **This was unbuildable until the business answered a question**: `buyback_leg` has exactly two values (DEALER, VENDOR) and `settlement_transactions.leg` uses it, so nothing could record a payment to a driver — collecting their bank account would have been pure liability. The model: paying the driver INSTEAD of the dealer is the SAME OUT payment of the SAME locked dealer_price to a different beneficiary, so `settlement_transactions.payee_provenance_id` (NULL = the dealer, and every existing row) needs **no new leg and does not touch M14** — we still pay dealer_price out exactly once. A driver-AND-dealer SPLIT is a genuinely different thing and is NOT modelled: that needs a third buyback_leg value (shared by purchase_orders/invoices/negotiation_rounds, where DRIVER is meaningless), a rewrite of both-legs-closed=>SETTLED, and a re-derivation of M14. Adds to `provenance_records`: prev_owner_pan (full — a tax id, not a credential), prev_owner_aadhaar_last4 (**LAST FOUR ONLY**, CHECK `^[0-9]{4}$` — a full Aadhaar is unstorable, verified 22001; DPDP/UIDAI), prev_owner_aadhaar_ref + _verified_at (the Decentro reference IS the evidence — reuse src/lib/kyc/), payee_account_number/ifsc/bank_name/beneficiary_name (full — you cannot pay a last-four). CHECKs verified to bite: full Aadhaar refused, payee override on the money-IN VENDOR leg refused (23514). All nullable — required is the submit gate's job, per E-191. Mirrored in `schema.ts`. | ✅ | ✅ | ✅ | ☐ |
| E-198_notification_multi_attachment | `buyback_notification_events.attachment_s3_keys text[]` — the event could name exactly ONE file, so the vendor quotation's battery photos were base64-inlined INTO the PDF instead: capped at 2/line and rendered at 54x40px, a size at which a swollen cell and a healthy one look identical, which defeats the entire reason for sending them (item 14: "the vendor should not have to log in just to see the battery condition"). The mailer never had this limit — `sendEmail()` has always taken `attachments[]`. NOT stored in `payload`: attachment keys are snapshotted at emit time so the dispatcher never re-derives what it sends, same rule as `recipient_ref`. The singular column STAYS and keeps the PDF: its absence is fatal (dispatch throws rather than send a "please quote" with no quotation), while a missing photo here is SKIPPED — two columns, two failure policies, which is the reason not to merge them. Additive, no backfill (NULL = no extra files, true of every existing row). No-ops with a NOTICE where the buyback tables don't exist (prod). Mirrored in `schema.ts`. | ✅ | ✅ | ✅ | ☐ |
| E-199_nbfc_risk_card_visibility | `nbfc_risk_card_visibility` — per-NBFC STRICT allowlist of which risk-hypothesis cards a partner may see on /nbfc/risk. Presence of a `(tenant_id → nbfc_tenants.id, hypothesis_id → risk_hypotheses.id)` row = visible; no row = hidden; a tenant with zero rows sees zero cards. NO seed (every partner starts blank until an admin selects). Unique `(tenant_id, hypothesis_id)` + `(tenant_id)` index; both FKs ON DELETE CASCADE. Filtered at DISPLAY time in `loadCards()` so it survives every "Re-run analysis" (a re-run only writes `risk_card_runs`). Applies everywhere (`nbfc_tenants`/`risk_hypotheses` exist on the NBFC-dashboard envs). Mirrored in `schema.ts`. | ✅ | ✅ | ☐ | ☐ |
| E-200_nbfc_doc_requests | `nbfc_doc_requests` — the NBFC-originated document/KYC request thread on the Acquire workspace + two additive tag columns on `other_document_requests` (`nbfc_request_id`, `source DEFAULT 'admin'`). Turns Acquire from read-only into the 7-hop loop NBFC→Admin→Dealer→Customer→Dealer→Admin→NBFC. ONE wrapper row → MANY `other_document_requests` children (which carry the files, reusing the existing tokenised /upload-docs machinery); a `request_type='message'` row (admin→NBFC direct) has zero children. `source='admin'` keeps every existing admin→dealer row and query unchanged. Idempotent, no backfill. `other_document_requests` exists everywhere; the new table is unconditional CREATE IF NOT EXISTS. Mirrored in `schema.ts`. | ✅ | ☐ | ☐ | ☐ |
| E-201_nbfc_document_verifications | `nbfc_document_verifications` — per-NBFC KYC verdict (pending\|verified\|queried\|rejected + notes) on each customer/co-borrower document, kept SEPARATE from the admin's own verification. One row per `(assignment_id, doc_for, doc_key)`; upsert. Feeds the admin "NBFC KYC Verification" card. Idempotent, no backfill. Mirrored in `schema.ts`. | ✅ | ☐ | ☐ | ☐ |
| E-202_nbfc_doc_requests_checks | CHECK backstops for E-200/E-201: `item_count <= 10` (Step-4 extra-items cap), and `status` / `request_type` / `verdict` restricted to their enum value sets. App-level validation is primary; these fail a bad write loudly. Each ADD CONSTRAINT guarded (duplicate_object / undefined_table → NOTICE). SQL-only (Drizzle doesn't model CHECKs here). | ✅ | ☐ | ☐ | ☐ |
| E-203_nbfc_manual_consent_request_type | Extends the E-202 `request_type` CHECK to admit `'manual_consent'` — the NBFC uploads a DPDP consent PDF for wet/manual signing, which rides the E-200 loop (NBFC→Admin→Dealer→Admin→NBFC) as a wrapper of that type. DROP-if-exists then re-add so it is idempotent and works whether or not E-202 was applied here. Guarded (undefined_table → NOTICE). SQL-only. **Apply AFTER E-200/E-202.** | ☐ | ☐ | ☐ | ☐ |
| E-204_nbfc_co_borrower_request_type | Extends the E-202 `request_type` CHECK to admit `'co_borrower'` — an NBFC-initiated co-borrower request (when the admin never flagged one). Rides the E-200 loop NBFC→Admin; the admin one-clicks "Request co-borrower from dealer" (triggers the standard dealer co-borrower KYC flow) then the wrapper is pushed back to the NBFC. DROP-if-exists then re-add the FULL value set (incl. `manual_consent`), so it is idempotent and self-contained whether or not E-203 was applied. Guarded (undefined_table → NOTICE). SQL-only. **Required for the NBFC "Request Co-Borrower" button — the insert fails the CHECK without it.** | ✅ | ☐ | ☐ | ☐ |
| E-205_nbfc_consent_template | Adds `consent_template_url` + `consent_template_size` to `nbfc_service_config` — the NBFC's own DPDP consent-template PDF, uploaded once in Settings and reused across all leads (Acquire e-sign/OTP signs THIS doc instead of the per-lead iTarang consent). Additive `ADD COLUMN IF NOT EXISTS`. Mirrored in `schema.ts`. | ✅ | ☐ | ☐ | ☐ |
| E-206_consent_records_initiated_by_tenant | Adds `initiated_by_tenant_id uuid` (nullable) to `consent_records` — stamps the NBFC tenant that captured a consent from Acquire so the NBFC's DPDP card shows only its own (NULL = iTarang/dealer; admin view unfiltered). Additive `ADD COLUMN IF NOT EXISTS`, no FK. Mirrored in `schema.ts`. | ✅ | ☐ | ☐ | ☐ |
| E-207_nbfc_verdict_attachments | Adds `attachments jsonb DEFAULT '[]'` to `nbfc_document_verifications` — supporting files (any type, `{url,name,type,size}`) the NBFC attaches to a per-document Approve/Reject/Request-correction from the Acquire KYC table; viewable by the admin in the "NBFC Actions" section. Additive `ADD COLUMN IF NOT EXISTS`. Mirrored in `schema.ts`. | ✅ | ☐ | ☐ | ☐ |
| E-208_product_selections_pre_sanction_docs | Adds `pre_sanction_doc_urls jsonb DEFAULT '[]'` to `product_selections` — the Step-4 dealer pre-sanction bucket (≤10 items, all formats; `{url,name,type,size}`; a combined PDF = one item). Viewable by NBFC (Acquire dossier) + admin. Additive `ADD COLUMN IF NOT EXISTS`. Mirrored in `schema.ts`. | ✅ | ☐ | ☐ | ☐ |
| E-209_nbfc_verdict_forwarded | Adds `forwarded_at timestamptz`, `forwarded_request_id varchar(255)`, `forwarded_by uuid` to `nbfc_document_verifications` — stamps an admin "Forward to dealer" on a queried/rejected NBFC verdict (E-209) and links the correction wrapper it spawned; primary→Step 2, co-borrower→Step 3. Additive `ADD COLUMN IF NOT EXISTS`. Mirrored in `schema.ts`. | ☐ | ☐ | ☐ | ☐ |
| E-210_ops_monitoring | Ops Console spine. Creates six tables: `ops_metric_samples` (raw time series, pruned to 30d), `ops_daily_snapshots` (daily rollup, never pruned, `UNIQUE(snapshot_date, metric_key, source)` makes the daily job re-runnable), `ops_collector_runs` (partial unique on `(collector_id) WHERE status='running'` — the single-flight lock, same trick as `risk_runs`), `ops_log_events` (agent-forwarded log lines, pruned to 14d, grouped by `fingerprint`), `ops_alert_rules` (editable thresholds, `UNIQUE(metric_key, source)`), `ops_alerts` (partial unique on `(metric_key, source) WHERE resolved_at IS NULL` — dedup for a flapping metric). Also adds two indexes on existing tables the console reads on a schedule: `ai_call_logs (ended_at)` (every cost query filters on it and it was unindexed) and `kyc_verifications (api_provider)`; both wrapped in `DO $do$ … EXCEPTION WHEN undefined_table` so the file still applies on a DB missing those tables. All `CREATE … IF NOT EXISTS`. Mirrored in `schema.ts`. | ✅ | ✅ | ✅ | ✅ |
| E-211_ai_call_logs_provider_idx | One index: `ai_call_logs (provider, ended_at DESC)`. Every panel on `/operations/elevenlabs` filters `provider = 'elevenlabs'`, and `provider` was unindexed — E-210 added `(ended_at)` only, so each date-bounded query scanned a window of ALL providers and the all-time "total usage" aggregate (deliberately unbounded) scanned the whole table, at a 60s auto-refresh. The composite serves both shapes: equality column first for the filter, ordered column second for the range scan and for `ORDER BY ended_at DESC LIMIT 20` without a sort. Also speeds the hourly per-provider `GROUP BY` in `/operations/spend` and the `spend.rollup` collector. Wrapped in `DO $do$ … EXCEPTION WHEN undefined_table` (with the `COMMENT ON INDEX` inside the block, so a skipped CREATE cannot leave an uncatchable comment behind). Index-only, strictly additive — **no `schema.ts` change** (Drizzle's `aiCallLogs` index list is not the source of truth here and adding it would imply a column change that does not exist). The page works without this; it is a performance fix. | ☐ | ✅ | ☐ | ☐ |
| E-212_vendor_credit_thresholds | **Data-only, no DDL.** Retunes the `vendor.credits_remaining` alert rule from warn 20,000 / crit 5,000 to warn 40,000 / crit 15,000. Sized in runway: ElevenLabs (the only vendor reporting a credit balance) burnt ~115k credits in its peak month against a ~253k quota ≈ 3.8k/day, so the old pair was worth ~5 days and ~1.3 days — a fire drill, not a warning. New pair is ~10 days and ~4 days. Mirrored in `registry.ts`, which seeds fresh environments. This file exists because `seedAlertRules()` inserts `ON CONFLICT DO NOTHING` by design (a hand-tuned threshold must survive a deploy), so a registry change alone never moves an existing row. The `UPDATE` is **conditional on the row still holding the exact old seeded pair** — a threshold already tuned by hand does not match and is left alone, preserving that same guarantee; idempotent as a side effect. Wrapped in `DO $do$ … EXCEPTION WHEN undefined_table` so it no-ops on a DB without E-210. | ☐ | ✅ | ☐ | ☐ |
| E-213_audit_logs_indexes | Three indexes on `audit_logs`, which has carried **zero** since `0000_*.sql`: `(created_at DESC)`, `(performed_by, created_at DESC)`, `(entity_type, entity_id)`. The table is one of the CRM's largest write logs (~53 INSERT sites) and is read on a hot path today: `/operations/team` runs **three** 30-day `created_at` aggregates *per render* (`team.ts:76-107`) behind a 60s `AutoRefresh`, the `team.rollup` collector runs a fourth hourly, and `/api/audit-log` filters on `performed_by` / `entity_id` / `entity_type` for the NBFC compliance viewer — every one a sequential scan. The composite puts the equality column first so a per-actor history needs no sort; it also serves the `/operations/usage` read path (E-214). `timestamp` is deliberately **not** indexed — the table carries both it and `created_at` (a historical duplication) but nothing in `src/` filters on it, and indexing an unread column costs write throughput for nothing. **`CONCURRENTLY` is NOT used** — it cannot run inside a `DO` block or any transaction; if prod's table is large enough that the ACCESS EXCLUSIVE lock matters, run the three `CREATE INDEX` statements standalone with `CONCURRENTLY` added (identical index names, so this file then no-ops). Wrapped in `DO $do$ … EXCEPTION WHEN undefined_table`, with the `COMMENT ON INDEX`es inside the block. Index-only, strictly additive — **no `schema.ts` change** (same reasoning as E-211). Pure performance fix; nothing breaks without it. | ☐ | ☐ | ☐ | ☐ |
| E-214_usage_analytics | Two tables behind `/operations/usage`: `user_login_events` (append-only, one row per credential entry) and `user_activity_sessions` (one row per session, **UPDATED in place** by the 5-minute heartbeat — `UNIQUE(session_id)` is the upsert target, and the row-per-ping alternative would have been ~1.0M rows/month against ~3.6k, i.e. a top-20 entry in `db.table_bytes` within three weeks). Neither takes an FK to `users` — same convention as `audit_logs.performed_by`, so a departed employee's history neither cascades away nor blocks the delete. **Deliberately stores no IP, no user-agent, no page path and no failed attempts**; that boundary is what makes the retention promise defensible, and the reasoning is written into the migration header rather than left implicit. Retention 90 days (logins) / 30 days (sessions), pruned by `runDailySnapshot()` — only AGGREGATES survive, in `ops_daily_snapshots`; **no per-person row is ever written to `ops_metric_samples`**, which is the part of the `collectors/team.ts` decision this does NOT reverse. `user_activity_sessions` also carries storage params (`fillfactor=80` + autovacuum tuning) because an UPDATE-per-heartbeat table churns dead tuples far faster than its row count suggests; Drizzle cannot express those, so their absence from `schema.ts` is expected and not drift. **Apply BEFORE shipping the code** — the write paths swallow their own errors by design (a login must never fail because analytics failed), so an unapplied migration surfaces as a permanently empty dashboard rather than a 500, which is far harder to diagnose. Mirrored in `schema.ts`. | ☐ | ☐ | ☐ | ☐ |
| E-215_module_usage | Per-module usage behind the new table on `/operations/usage`: `module_usage_daily` (counters at grain `(day, module, role_bucket)`, permanent) and `module_visit_keys` (2-day scratch dedupe so `sessions` counts distinctly). **Answers "which parts of the CRM are used" WITHOUT storing a page path** — the browser maps its own location against a closed 7-value allow-list (`MODULES` in `src/lib/usage/constants.ts`) and sends the LABEL; `/nbfc/applications/PL-2291?tab=kyc` is transmitted as `nbfc`. **`module_usage_daily` has no `user_id` column and cannot get one** — that is the whole design, and it is why E-215 adds no new per-person surface and needs no read-audit, row cap or expiry. `role_bucket` is `internal`|`external` and deliberately **not** the role: there is exactly one `ceo`, so `(day,'nbfc','ceo',sessions=1)` would be a per-person row wearing an aggregate's name. `module` carries **no CHECK/enum** on purpose — an unknown label lands as `other` and stays visible rather than failing a heartbeat; the allow-list is enforced by `normaliseModule()`. `module_visit_keys` holds `md5(session_id,module,day)` — **not anonymised** (see the header's RESIDUAL EXPOSURE note: recomputable by anyone who can read `user_activity_sessions`, which is why the prune is 2 days). Storage params (`fillfactor=70` + autovacuum tuning) on `module_usage_daily` because ~6.5k pings/day land as UPDATEs on ~14 live rows; Drizzle cannot express them, so their absence from `schema.ts` is expected and not drift. Safe to ship before applying — `getModuleUsage()` never throws, so an unapplied E-215 shows the table as "unavailable" and leaves the rest of the page working. Mirrored in `schema.ts`. | ☐ | ☐ | ☐ | ☐ |
| E-195_scrap_vendor_login | `users.vendor_entity_id` (varchar(255) → accounts.id, partial index WHERE NOT NULL) — the missing link that let BRD M24's deferred vendor login finally exist. A vendor was already `accounts` + `business_entity_roles(role='SCRAP_VENDOR')` + `scrap_vendors` (E-186); nothing said WHICH vendor a `users` row acts for. **NOT** reused `users.dealer_id`: it holds the right value (accounts.id and dealer_code are the same string) but is joined against the `dealers` table by dealer_code app-wide, and a scrap vendor has no dealers row — every such join would silently return nothing instead of failing. **No enum to extend**: `users.role` is a bare varchar(50) with no constraint, so `'scrap_vendor'` needs no DDL — it is registered in six hardcoded TypeScript lists instead (middleware `roleDashboards`, sidebar `roleNavigation`, sidebar `inferredRole`, both login redirect chains, `lib/roles.ts`), and missing one fails **silently**. FK is NOT ON DELETE CASCADE — deleting an account must not silently delete logins. **Applies EVERYWHERE incl. prod** (`users`/`accounts` exist on every env, unlike the buyback tables); guarded anyway. Mirrored in `schema.ts`. | ✅ | ✅ | ✅ | ☐ |
| E-200_notifications_archive_delete | `notifications.archived_at` + `notifications.deleted_at` (both timestamptz, nullable) + partial index `notifications_user_active_idx ON (user_id) WHERE deleted_at IS NULL` — soft archive/delete for the buyback notification centre (items 12/13) so Archive/Delete hide a row without losing it (escalation-safety + audit). NULL = active/undeleted, so no backfill. **Applies EVERYWHERE incl. prod** — `notifications` is the whole CRM's bell and exists on every env (unlike the buyback tables), so no table guard. Renumbered from E-199 (Rushikesh's `E-199_nbfc_risk_card_visibility` took that slot on main). Mirrored in `schema.ts` so `db:push` users don't drop these. | ☐ | ☐ | ☐ | ☐ |
| E-201_battery_spec_mileage_band | `battery_spec_models.min_mileage_km_per_ah` + `max_mileage_km_per_ah` (both numeric(6,3), nullable) — the normal km-per-Ah efficiency band for the Intellicar mileage charts (Mileage Trend / Per-Cycle Mileage / Ah vs Mileage), which previously had only a COMPUTED "pack's own best" baseline and no configured range. Spec-only per-model, exactly like E-190's `rated_capacity_ah`: resolved via `device_battery_map.battery_model`, NO app_settings/env/default rung, NULL = no line drawn. Seeds the `LFP-51V-105AH` row with an example 0.35–0.65 band (placeholder, tune with real fleet numbers) via an idempotent `UPDATE … WHERE … IS NULL` that never clobbers a hand-edit. **Applies EVERYWHERE** — `battery_spec_models` exists on the Intellicar envs (E-190). Mirrored in `schema.ts`. | ☐ | ☐ | ☐ | ☐ |
| E-202_dealer_type | `dealer_onboarding_applications.dealer_type` + `dealers.dealer_type` (both varchar(16), nullable) — dealer business type New/Scrap/Both, selected in onboarding Step 1 and carried onto the canonical dealers row at approval. Free-text (not enum) per this table family's convention (company_type/source/payment_method). Backfilled to 'new' for existing rows (idempotent `UPDATE … WHERE dealer_type IS NULL`). Only CAPTURES the type — no agreement/dashboard branching yet. **Applies EVERYWHERE incl. prod** — `dealer_onboarding_applications`/`dealers` exist on every env; **apply BEFORE shipping the code** (Drizzle lists the column in every onboarding INSERT, so an unapplied column 500s every autosave/submit). Mirrored in `schema.ts`. | ☐ | ☐ | ✅ | ☐ |

<!-- E-185/E-186 verified on db-1 (database-1.…ap-south-1) on 2026-07-13 by querying
     pg_tables / pg_enum / pg_trigger / pg_indexes directly: all 24 tables, 21 enum
     states, both immutability triggers and the one-AGREED-per-deal partial index are
     present, and catalog_variants is seeded (14 variants). The `sandbox` and `prod`
     columns are a DIFFERENT RDS instance each — still unapplied there.

     E-187/E-188 re-run + verified on db-1 on 2026-07-14 (idempotent re-apply, every
     statement skipped as existing): all 8 money/compliance tables, buyback_invoice_no_seq,
     invoices_one_live_per_deal_leg + settlement_transactions_leg_sub_unique +
     agreements_one_live_per_entity_role partial indexes, settlement_manual_needs_proof +
     settlement_amount_positive CHECKs, pickups variance/e-way columns and buyback_photos
     dedup columns all present.

     SANDBOX ticked for E-185..E-188 on 2026-07-14 because sandbox is NOT a separate
     RDS: its shared/.env DATABASE_URL points at db-1 (database-1.…/postgres), verified
     by reading the box env and querying through it. The "different RDS instance each"
     note above is stale for sandbox; it still holds for prod. -->

<!-- 2026-07-18 (session): db-2 (database-2.…, what .env.local's DATABASE_URL points at)
     was throwing `column "vendor_entity_id" does not exist` on every /api/user/profile
     and `buyback-dispatch tick failed` every 30s. Root cause was per-DB migration lag,
     confirmed by querying information_schema.columns on BOTH db-1 and db-2:
       - E-195 (users.vendor_entity_id) — applied to db-2, now ✅ on db-1 AND db-2.
       - E-196/E-197/E-198 (buyback proforma / owner-identity / attachment_s3_keys) —
         applied to db-2 (were already on db-1); attachment_s3_keys was the direct cause
         of the buyback-dispatch failure. All three now ✅ on db-1 AND db-2.
       - E-189 (inventory_transfers canonical ids) — ✅ on db-2 (pre-existing) but NOT
         applied on db-1: its guard RAISEs because db-1's inventory_transfers still holds
         the pre-0038 integer-PK design AND is non-empty, so it can't auto-rebuild. Left ☐
         on db-1 — needs a manual data migration or an empty-table window.
       - E-194 (buyback_pickup_addresses.owner_kind) — still MISSING on db-2. db-2's
         intake queue lacks the owner_kind column; left ☐, still to apply.
     Ticks reflect information_schema truth, not assumption. -->

<!-- NUMBER COLLISION: E-185..E-188 exist twice — the risk-engine family
     (E-185_risk_card_verdict_source … E-188_risk_hypothesis_promotion, developed on
     Rushikesh-claude) and the peakAmp buyback family (E-185_buyback_core …
     E-188_buyback_compliance_trust, developed on main). Both were numbered from the
     same free slot before the branches merged. They are independent — no shared
     tables, no cross-family ordering — and each family is internally ordered, so both
     were kept rather than renumbered (they are already applied under these names).
     Next free number is E-216 (E-215 is module_usage). Match on the FULL filename,
     not the number alone — E-185..E-188 and E-200..E-202 each name TWO different
     migrations, so "is E-2NN applied?" is not a well-formed question.

     E-190_battery_spec_models was authored as E-189 and applied to db-1 + sandbox under
     that name, before E-189_inventory_transfers_canonical_ids landed on main. It was
     renumbered to E-190 rather than adding a THIRD duplicate slot. The DDL is unchanged
     and idempotent, so the db-1/sandbox ticks below still hold — re-running the E-190
     file against them is a no-op (it only rewrites two COMMENT ONs). -->

> Add a new row whenever you create an `E-<n>_*.sql` file. When `DATABASE_URL`
> points at a DB and you confirm a migration is present, tick that env's box.
