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
| E-165_nbfc_byo_provider_handoff | nbfc byo provider handoff | ☐ | ☐ | ☐ | ☐ |
| E-166_nbfc_provider_credentials | nbfc provider credentials | ☐ | ☐ | ☐ | ☐ |
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
| E-175_dealer_owner_aadhaar | dealer_onboarding_applications.owner_aadhaar_no + owner_aadhaar_verified (dealer agreement Aadhaar match) | ☐ | ☐ | ☐ | ☐ |
| E-176_consent_signer_name_score | consent_records.signer_name_match_score (Aadhaar e-sign name-match signal) | ✅ | ☐ | ☐ | ☐ |
| E-177_loan_calculator | dealer loan calculator: calc_* tables (nbfcs/schemes/model_caps/component_prices/coverage/settings/config_versions/audit_log/leads) + guard indexes & checks | ✅ | ☐ | ☐ | ☐ |
| E-178_calc_otp_search_history | calc_otp_verifications + calc_leads otp/wa columns (OTP-gated calculator, WhatsApp results, admin search history) | ✅ | ☐ | ☐ | ☐ |
| E-179_lead_registry | lead_registry — central capture of every new lead (dealer/customer/oem/nbfc, web+whatsapp) with name/phone + source link | ✅ | ☐ | ☐ | ☐ |
| E-180_consent_otp_verifications | consent_otp_verifications + consent_records otp_verification_id/otp_verified_at (OTP-based customer consent, replaces Digio Aadhaar e-sign) | ✅ | ☐ | ☐ | ☐ |
| E-181_nbfc_emi_tracker_overrides | nbfc_emi_tracker_overrides — per-loan display overrides for the EMI Tracker table (borrower/serial/emi/next_due/last_paid/progress/status/dpd/mandate/next_auto_debit) | ✅ | ☐ | ☐ | ☐ |
| E-182_emi_tracker_financier | nbfc_emi_tracker_overrides.financier — free-text financier label shown in a new Finance column on the EMI Tracker | ✅ | ☐ | ☐ | ☐ |
| E-183_emi_tracker_standalone | nbfc_emi_tracker_overrides.is_standalone + loan_application_id made nullable + partial unique index on (tenant, lower(vehicleno)) WHERE is_standalone — force-import bulk-upload rows with no matching loan as display-only tracker entries | ✅ | ☐ | ☐ | ☐ |
| E-184_device_battery_map_location | device_battery_map.state + city (Intellicar Fleet Overview State/City filters) | ✅ | ✅ | ✅ | ✅ |
| E-185_risk_card_verdict_source | risk_card_runs.verdict_source (hand_coded/sandbox/none/legacy_llm) + backfill; severity vocabulary widened to include inconclusive/error so a failed test stops rendering as a green OK card | ✅ | ☐ | ☐ | ☐ |
| E-186_risk_hypothesis_text_matches_code | Rewrites the 5 hand-coded risk_hypotheses descriptions so the text shown to operators matches the test that runs (geo-shift said "100 km from onboarding centroid" but checked an India bounding box) and stops hard-coding threshold values now governed by nbfc_risk_rules | ✅ | ☐ | ☐ | ☐ |
| E-187_risk_runs | risk_runs table (one row per risk-engine invocation) + risk_card_runs.run_id. Partial unique index (tenant_id) WHERE status='running' is the concurrency lock; the table is also the freshness source for the Risk page | ✅ | ☐ | ☐ | ☐ |
| E-188_risk_hypothesis_promotion | risk_hypotheses.promoted_at/promoted_by/retire_reason. An unvetted llm-v1 hypothesis is capped at severity=warn and cannot raise a High Alert until a human promotes it; hand-coded rows backfilled as promoted. Enables catalogue reuse + retirement instead of unbounded growth | ☐ | ☐ | ☐ | ☐ |
| E-189_inventory_transfers_canonical_ids | Rebuilds inventory_transfers on canonical id types (varchar(64) PK, varchar(255) dealer ids → accounts.id, uuid actor ids → users.id). This DB still had the pre-0038 integer-PK/integer-FK/rejected_* design, so every transfer read blew up with 22P02 "invalid input syntax for type integer: ACC-…". Supersedes 0038; guarded — drops only when the stale schema is present AND empty, else RAISEs | ☐ | ☐ | ☐ | ☐ |
| E-185_buyback_core | peakAmp Battery Buyback Portal core schema (BRD §3) — buyback_deal_status enum (all 21 states) + catalog_variants, business_entity_roles, buyback_pickup_addresses, buyback_requests/batches/lines/units, buyback_photos, provenance_records, info_requests, buyback_deals, negotiation_rounds(+_lines), final_offers(+_lines), deal_line_locks, buyback_activity_log (INSERT-only trigger), buyback_notification_events | ☐ | ✅ | ✅ | ☐ |
| E-186_buyback_vendor_leg | peakAmp vendor leg & fulfilment (M09–M11 + minimal M05) — scrap_vendors, vendor_threads (partial UNIQUE: one AGREED vendor per deal), vendor_thread_lines, purchase_orders(+_lines, tax cols modelled not ruled), pickups, buyback_po_no_seq; buyback_notification_events gains attempts/next_attempt_at/recipient_ref/attachment_s3_key for dispatch; deal_line_locks becomes FILL-ONCE via trigger (only vendor_price, only once). **Apply AFTER E-185.** | ☐ | ✅ | ✅ | ☐ |
| E-187_buyback_money | peakAmp money leg (M12–M14) — invoices (partial UNIQUE: one LIVE invoice per deal+leg, RETURNED ones kept as evidence), invoice_lines (per-line `matched` verdict + tax cols), settlement_transactions (TXN-{n}-D OUT / -V IN; **CHECK constraint makes an unevidenced MANUAL payout impossible**; UNIQUE leg_sub_id so a dealer cannot be paid twice), buyback_invoice_no_seq. **Apply AFTER E-186.** | ☐ | ✅ | ✅ | ☐ |
| E-188_buyback_compliance_trust | peakAmp compliance & trust (Sprints 3–4) — agreements (Digio eSign, dealers AND vendors; one live per entity+role, declined ones kept); catalog_price_history + catalog_price_reviews (M16 versioned price books + weekly nudge); bank_statement_imports/_rows (M13 STATEMENT reconcile) + settlement_transactions.statement_row_id; buyback_photos dedup (phash index + dup_flag: **DUPLICATE_CROSS_DEALER is the fraud case**); pickups BWM gate (expected_counts, variance_ack_required — blocks payout until the dealer acknowledges a count variance). **Apply AFTER E-187.** | ☐ | ✅ | ✅ | ☐ |
| E-190_battery_spec_models | battery_spec_models catalog (per-model rated voltage/capacity + under/over-voltage, over-current, over-temp display thresholds) + device_battery_map.battery_model logical FK — Intellicar electrical analytics judge packs against their model spec (resolution: spec > app_settings > env > defaults); seeds placeholder LFP-51V-105AH | ☐ | ✅ | ✅ | ☐ |
| E-191_buyback_line_battery_specs | buyback_lines gains 11 nullable dealer-declared spec columns: brand, chemistry (NMC/LFP), form_factor (CELL/PRISMATIC/CYLINDRICAL), nominal_voltage, nominal_ampere, unit_weight_kg, warranty_cycles, functional_qty, non_functional_qty, iot_battery, iot_brand_name. Required subset enforced by the submit gate, not NOT NULL. **Apply AFTER E-185** (no-ops with a NOTICE where buyback tables don't exist — i.e. prod). | ☐ | ☐ | ☐ | ☐ |
| E-192_buyback_scale_indexes | Scale pack for 10K+ dealers: `CREATE EXTENSION pg_trgm` (needs rds_superuser — see file header); btree `buyback_requests(submitted_at NULLS LAST, created_at)` (the review queue's own sort), `buyback_activity_log(deal_id)`, partial `settlement_transactions(txn_date DESC) WHERE closed_at IS NOT NULL` (the ledger), FK indexes on `buyback_lines.variant_id`/`buyback_photos.unit_id`/`pickups.batch_id`; GIN trigram indexes for leading-wildcard admin/dealer search (M23) on `buyback_requests.request_no`, `provenance_records.{vehicle_no,rc_number,prev_owner_name}`, `settlement_transactions.{leg_sub_id,group_txn_id,txn_ref}`, and `accounts.{business_entity_name,gstin}` (accounts indexes in their OWN DO block since `accounts` exists on every env, unlike the buyback tables). **Apply AFTER E-185/186/187** for the buyback-table indexes; the `accounts` indexes apply everywhere including prod. Mirrored in `src/lib/db/schema.ts` so `db:push` users don't drop these. | ☐ | ☐ | ☐ | ☐ |
| E-193_buyback_gateway_payments | buyback_gateway_transactions — the ATTEMPT behind an online gateway money move (RazorpayX payout to a dealer, Razorpay Payment Link to a vendor); only a terminal PROCESSED/PAID mints a settlement_transactions row (method='API'). buyback_gateway_kind/buyback_gateway_status enums; partial UNIQUE `(deal_id, leg)` WHERE status is in-flight is the double-click race guard, partial UNIQUE `provider_ref` is the webhook idempotency guard. Also adds `accounts.bank_beneficiary_name` (RazorpayX beneficiary name, falls back to business_entity_name). **Apply AFTER E-185/E-187** — the gateway table no-ops with a NOTICE where those (or their enum types) don't exist yet (prod); the `accounts` column applies everywhere. Dead code this round — nothing imports it yet. | ☐ | ☐ | ☐ | ☐ |

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

<!-- NUMBER COLLISION: E-185..E-188 exist twice — the risk-engine family
     (E-185_risk_card_verdict_source … E-188_risk_hypothesis_promotion, developed on
     Rushikesh-claude) and the peakAmp buyback family (E-185_buyback_core …
     E-188_buyback_compliance_trust, developed on main). Both were numbered from the
     same free slot before the branches merged. They are independent — no shared
     tables, no cross-family ordering — and each family is internally ordered, so both
     were kept rather than renumbered (they are already applied under these names).
     Next free number is E-191. Match on the FULL filename, not the number alone.

     E-190_battery_spec_models was authored as E-189 and applied to db-1 + sandbox under
     that name, before E-189_inventory_transfers_canonical_ids landed on main. It was
     renumbered to E-190 rather than adding a THIRD duplicate slot. The DDL is unchanged
     and idempotent, so the db-1/sandbox ticks below still hold — re-running the E-190
     file against them is a no-op (it only rewrites two COMMENT ONs). -->

> Add a new row whenever you create an `E-<n>_*.sql` file. When `DATABASE_URL`
> points at a DB and you confirm a migration is present, tick that env's box.
