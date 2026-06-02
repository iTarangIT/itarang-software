// Applies the FULL missing migration block E-109 → E-153 in dependency order
// against DATABASE_URL (.env.local). Diagnostics confirmed database-2 is
// missing this entire range.
//
// Notes:
//  - E-110..E-119 each have TWO files sharing the same E-number (repo numbering
//    collision). Both are applied; the two tracks are independent.
//  - E-149 is SKIPPED — it does INSERT INTO storage.buckets (Supabase storage),
//    which does not exist on this AWS RDS host. Apply that one on Supabase.
//  - Every file is hand-written idempotent + additive, so re-running the whole
//    batch is a no-op once in sync.
//  - STOPS on the first error so nothing cascades. Re-run after fixing — the
//    already-applied prefix is a no-op.
//  - WATCH E-117b (widen_score_loan_refs) and E-130 (addendum_foundation):
//    both touch loan_sanctions, which project memory flags as having pre-existing
//    db:push drift. If the batch stops on one of these, send me the error.
//
// Run via:  ! node scripts/_apply-e109-e153.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.*)$/m);
if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
const url = m[1].trim().replace(/^["']|["']$/g, "");

const FILES = [
  "E-109_dialer_campaigns.sql",
  "E-109_nbfc_lsp_agreement_signers.sql", // creates table that E-112b ALTERs — must precede it
  "E-110_call_costs.sql",
  "E-110_nbfc_lsp_agreement_template_url.sql",
  "E-111_drop_ai_call_logs_lead_id_fkey.sql",
  "E-111_nbfc_correction_rounds.sql",
  "E-112_dealer_leads_part0_columns.sql",
  "E-112_nbfc_lsp_agreement_signer_status.sql",
  "E-113_lead_touchpoints.sql",
  "E-113_loan_products_scheme_highlights.sql",
  "E-114_lead_visits.sql",
  "E-114_loan_products_active_locations.sql",
  "E-115_lead_escalations.sql",
  "E-115_loan_products_cibil_range.sql",
  "E-116_dealer_lead_commercials.sql",
  "E-116_lead_products.sql",
  "E-117_dealer_lead_status_history.sql",
  "E-117_widen_score_loan_refs.sql",
  "E-118_asm_territories.sql",
  "E-118_nbfc_buyback_requests.sql",
  "E-119_nbfc_battery_evaluations.sql",
  "E-119_upload_batches.sql",
  "E-120_assignment_config.sql",
  "E-121_holiday_calendar.sql",
  "E-122_duplicate_merge_requests.sql",
  "E-123_interest_level_overrides.sql",
  "E-124_user_preferences.sql",
  "E-125_cost_currency_default_inr.sql",
  "E-126_dealer_leads_source_column.sql",
  "E-127_onboarding_application_part0_columns.sql",
  "E-128_dealer_lead_commercials_product_lines.sql",
  "E-129_seed_auction_lots_demo.sql",
  "E-130_addendum_foundation.sql",
  "E-131_nbfc_lead_assignments.sql",
  "E-132_zoho_finance_and_expenses.sql",
  "E-133_nbfc_service_config_and_rbac.sql",
  "E-134_enach_mandates.sql",
  "E-135_video_kyc.sql",
  "E-136_field_investigations.sql",
  "E-137_nbfc_wallet_charging.sql",
  "E-138_manual_handoff.sql",
  "E-139_backfill_nbfc_tenant_binding.sql",
  "E-140_nbfc_financing_offers.sql",
  "E-141_financing_dead_end.sql",
  "E-142_nbfc_users_notification_prefs.sql",
  "E-143_nbfc_users_role_normalise.sql",
  "E-144_nbfc_loans_drop_loan_application_fk.sql",
  "E-145_enach_razorpay_fields.sql",
  "E-146_nbfc_loan_agreements.sql",
  "E-147_nbfc_service_config_enach_handoff_itarang_razorpay.sql",
  "E-148_field_investigation_full_spec.sql",
  // E-149 skipped — Supabase storage bucket, not applicable to AWS RDS.
  "E-150_field_investigations_status_widen.sql",
  "E-151_nbfc_loan_agreement_source_doc.sql",
  "E-152_vkyc_passive_link.sql",
  "E-153_vkyc_mode_allow_passive.sql",
];

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });

try {
  console.log("HOST:", new URL(url).hostname);

  // Pre-step: E-139 backfills nbfc.tenant_id, but that column comes from E-026B
  // which is only partially applied on this DB (nbfc_tenants exists, the column
  // does not). Add ONLY the schema half of E-026B here — the column + index —
  // and deliberately SKIP E-026B's legal_name UPDATE backfill, which is the
  // known cause of the "15 rows collapsed onto one tenant" drift bug. E-139's
  // canonical-slug binding (run below) is the correct replacement.
  process.stdout.write("→ [pre] E-026B schema: nbfc.tenant_id column".padEnd(54) + " ... ");
  await sql.unsafe(`
    ALTER TABLE "nbfc" ADD COLUMN IF NOT EXISTS "tenant_id" uuid REFERENCES "nbfc_tenants"("id");
    CREATE INDEX IF NOT EXISTS "nbfc_tenant_id_idx" ON "nbfc" ("tenant_id");
  `);
  console.log("OK");

  console.log("Applying", FILES.length, "migrations (E-149 skipped)\n" + "=".repeat(64));
  let ok = 0;
  for (const f of FILES) {
    const body = readFileSync("drizzle/" + f, "utf8");
    process.stdout.write("→ " + f.padEnd(52) + " ... ");
    try {
      await sql.unsafe(body);
      console.log("OK");
      ok++;
    } catch (e) {
      console.log("FAILED");
      console.error("\n   error:", e.code || "", e.message);
      if (e.detail) console.error("   detail:", e.detail);
      console.error(`\nStopped at ${f} (${ok}/${FILES.length} applied). Fix and re-run — the already-applied prefix is a no-op.`);
      process.exit(1);
    }
  }
  console.log("=".repeat(64));
  console.log(`All ${ok}/${FILES.length} migrations applied successfully.`);
  console.log("Verify with: node scripts/_diag-drift-110-126.mjs && node scripts/_diag-drift-128-153.mjs");
} finally {
  await sql.end();
}
