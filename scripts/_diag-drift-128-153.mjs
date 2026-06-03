import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.*)$/m);
if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
const url = m[1].trim().replace(/^["']|["']$/g, "");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });

const tableExists = async (t) =>
  (await sql`SELECT to_regclass(${"public." + t}) AS r`)[0].r != null;

const colExists = async (t, c) =>
  (await sql`SELECT 1 FROM information_schema.columns
              WHERE table_name = ${t} AND column_name = ${c} LIMIT 1`).length > 0;

const constraintExists = async (name) =>
  (await sql`SELECT 1 FROM pg_constraint WHERE conname = ${name} LIMIT 1`).length > 0;

const colMaxLen = async (t, c) => {
  const r = await sql`SELECT character_maximum_length AS l FROM information_schema.columns
                       WHERE table_name = ${t} AND column_name = ${c} LIMIT 1`;
  return r.length ? r[0].l : null;
};

// Each check returns "APPLIED" / "MISSING" / "PARTIAL: ..." / "N/A: ..."
const checks = {
  "E-128 dealer_lead_commercials.product_lines": async () =>
    (await colExists("dealer_lead_commercials", "product_lines")) ? "APPLIED" : "MISSING",

  "E-129 seed auction_lots demo (data seed)": async () => {
    if (!(await tableExists("auction_lots"))) return "N/A: auction_lots table absent";
    const r = await sql`SELECT count(*)::int AS n FROM auction_lots`;
    return `data-seed — auction_lots has ${r[0].n} row(s) (cannot confirm seed vs real)`;
  },

  "E-130 leads/product_selections/nbfc_loan_products/loan_sanctions cols": async () => {
    const r = {
      "leads.resident_status": await colExists("leads", "resident_status"),
      "product_selections.battery_photo_urls": await colExists("product_selections", "battery_photo_urls"),
      "nbfc_loan_products.credit_bureau": await colExists("nbfc_loan_products", "credit_bureau"),
      "loan_sanctions.sanctioned_by_type": await colExists("loan_sanctions", "sanctioned_by_type"),
    };
    const miss = Object.entries(r).filter(([, v]) => !v).map(([k]) => k);
    return miss.length ? "MISSING: " + miss.join(", ") : "APPLIED";
  },

  "E-131 nbfc_lead_assignments": async () =>
    (await tableExists("nbfc_lead_assignments")) ? "APPLIED" : "MISSING",

  "E-132 zoho_invoices/expense_submissions/zoho_sync_state": async () => {
    const miss = [];
    for (const t of ["zoho_invoices", "expense_submissions", "zoho_sync_state"])
      if (!(await tableExists(t))) miss.push(t);
    return miss.length ? "MISSING: " + miss.join(", ") : "APPLIED";
  },

  "E-133 nbfc_service_config/nbfc_step_owners + lead_assign snapshot": async () => {
    const miss = [];
    for (const t of ["nbfc_service_config", "nbfc_step_owners"])
      if (!(await tableExists(t))) miss.push("table " + t);
    if (await tableExists("nbfc_lead_assignments") &&
        !(await colExists("nbfc_lead_assignments", "service_config_snapshot")))
      miss.push("nbfc_lead_assignments.service_config_snapshot");
    return miss.length ? "MISSING: " + miss.join(", ") : "APPLIED";
  },

  "E-134 enach_mandates": async () =>
    (await tableExists("enach_mandates")) ? "APPLIED" : "MISSING",

  "E-135 video_kyc_verifications/video_kyc_attempts": async () => {
    const miss = [];
    for (const t of ["video_kyc_verifications", "video_kyc_attempts"])
      if (!(await tableExists(t))) miss.push(t);
    return miss.length ? "MISSING: " + miss.join(", ") : "APPLIED";
  },

  "E-136 field_investigations": async () =>
    (await tableExists("field_investigations")) ? "APPLIED" : "MISSING",

  "E-137 nbfc_wallets/nbfc_charge_catalogue/nbfc_wallet_ledger": async () => {
    const miss = [];
    for (const t of ["nbfc_wallets", "nbfc_charge_catalogue", "nbfc_wallet_ledger"])
      if (!(await tableExists(t))) miss.push(t);
    return miss.length ? "MISSING: " + miss.join(", ") : "APPLIED";
  },

  "E-138 manual_handoffs": async () =>
    (await tableExists("manual_handoffs")) ? "APPLIED" : "MISSING",

  "E-139 backfill nbfc tenant binding (data backfill)": async () =>
    "data-backfill — no schema sentinel (verify via nbfc_lead_assignments tenant rows if needed)",

  "E-140 nbfc_financing_offers": async () =>
    (await tableExists("nbfc_financing_offers")) ? "APPLIED" : "MISSING",

  "E-141 leads.financing_decline_category/_unavailable_at": async () => {
    const miss = [];
    if (!(await colExists("leads", "financing_decline_category"))) miss.push("financing_decline_category");
    if (!(await colExists("leads", "financing_unavailable_at"))) miss.push("financing_unavailable_at");
    return miss.length ? "MISSING: " + miss.join(", ") : "APPLIED";
  },

  "E-142 nbfc_users.notification_prefs": async () => {
    if (!(await tableExists("nbfc_users"))) return "N/A: nbfc_users absent";
    return (await colExists("nbfc_users", "notification_prefs")) ? "APPLIED" : "MISSING";
  },

  "E-143 nbfc_users role normalise (data/constraint)": async () =>
    "constraint/data — no simple sentinel (role values normalised in-place)",

  "E-144 drop nbfc_loans loan_application FK": async () => {
    if (!(await tableExists("nbfc_loans"))) return "N/A: nbfc_loans absent";
    const present = await constraintExists("nbfc_loans_loan_application_id_fkey");
    return present ? "MISSING (FK still present)" : "APPLIED (FK absent)";
  },

  "E-145 enach_mandates.razorpay_*": async () => {
    if (!(await tableExists("enach_mandates"))) return "N/A: enach_mandates absent";
    const miss = [];
    for (const c of ["razorpay_order_id", "razorpay_customer_id", "razorpay_token_id"])
      if (!(await colExists("enach_mandates", c))) miss.push(c);
    return miss.length ? "MISSING: " + miss.join(", ") : "APPLIED";
  },

  "E-146 nbfc_loan_agreements": async () =>
    (await tableExists("nbfc_loan_agreements")) ? "APPLIED" : "MISSING",

  "E-147 nbfc_service_config enach_handoff_check (itarang_razorpay)": async () => {
    if (!(await tableExists("nbfc_service_config"))) return "N/A: nbfc_service_config absent";
    const r = await sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
                         WHERE conname = 'nbfc_service_config_enach_handoff_check' LIMIT 1`;
    if (!r.length) return "MISSING (constraint absent)";
    return r[0].def.includes("itarang_razorpay") ? "APPLIED" : "MISSING (old constraint, no itarang_razorpay)";
  },

  "E-148 nbfc_fi_agents/field_investigation_photos + FI cols": async () => {
    const miss = [];
    for (const t of ["nbfc_fi_agents", "field_investigation_photos"])
      if (!(await tableExists(t))) miss.push("table " + t);
    if (await tableExists("field_investigations") &&
        !(await colExists("field_investigations", "attempt_no")))
      miss.push("field_investigations.attempt_no");
    return miss.length ? "MISSING: " + miss.join(", ") : "APPLIED";
  },

  "E-149 storage bucket 'nbfc-documents'": async () => {
    try {
      const r = await sql`SELECT 1 FROM storage.buckets WHERE id = 'nbfc-documents' LIMIT 1`;
      return r.length ? "APPLIED" : "MISSING (bucket absent)";
    } catch (e) {
      return "N/A: storage.buckets not queryable (" + (e.code || e.message) + ")";
    }
  },

  "E-150 field_investigations.status widened to varchar(32)": async () => {
    if (!(await tableExists("field_investigations"))) return "N/A: field_investigations absent";
    const l = await colMaxLen("field_investigations", "status");
    return l != null && l >= 32 ? `APPLIED (len=${l})` : `MISSING (len=${l})`;
  },

  "E-151 nbfc_loan_agreements.source_document_url": async () => {
    if (!(await tableExists("nbfc_loan_agreements"))) return "N/A: nbfc_loan_agreements absent";
    return (await colExists("nbfc_loan_agreements", "source_document_url")) ? "APPLIED" : "MISSING";
  },

  "E-152 video_kyc_verifications.link_channel/_sent_at/_expires_at": async () => {
    if (!(await tableExists("video_kyc_verifications"))) return "N/A: video_kyc_verifications absent";
    const miss = [];
    for (const c of ["link_channel", "link_sent_at", "link_expires_at"])
      if (!(await colExists("video_kyc_verifications", c))) miss.push(c);
    return miss.length ? "MISSING: " + miss.join(", ") : "APPLIED";
  },

  "E-153 video_kyc mode_check allows 'passive'": async () => {
    if (!(await tableExists("video_kyc_verifications"))) return "N/A: video_kyc_verifications absent";
    const r = await sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
                         WHERE conname = 'video_kyc_verifications_mode_check' LIMIT 1`;
    if (!r.length) return "no CHECK constraint present (any mode allowed)";
    return r[0].def.includes("passive") ? "APPLIED" : "MISSING (constraint rejects 'passive')";
  },
};

try {
  console.log("HOST:", new URL(url).hostname);
  console.log("=".repeat(70));
  for (const [label, fn] of Object.entries(checks)) {
    let res;
    try { res = await fn(); } catch (e) { res = "ERROR: " + (e.code || e.message); }
    const flag = res.startsWith("APPLIED") ? "✓" : res.startsWith("MISSING") ? "✗" : "•";
    console.log(`${flag} ${label}\n    ${res}`);
  }
} finally {
  await sql.end();
}
