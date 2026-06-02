import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.*)$/m);
if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
const url = m[1].trim().replace(/^["']|["']$/g, "");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
const T = async (t) => (await sql`SELECT to_regclass(${"public." + t}) AS r`)[0].r != null;
const C = async (t, c) =>
  (await sql`SELECT 1 FROM information_schema.columns WHERE table_name=${t} AND column_name=${c} LIMIT 1`).length > 0;
const CON = async (n) =>
  (await sql`SELECT 1 FROM pg_constraint WHERE conname=${n} LIMIT 1`).length > 0;

const checks = {
  "E-110a call_costs (ai_call_logs.total_cost_cents)": async () =>
    (await T("ai_call_logs")) ? ((await C("ai_call_logs", "total_cost_cents")) ? "APPLIED" : "MISSING") : "N/A: ai_call_logs absent",
  "E-110b nbfc_lsp_agreements.agreement_template_url": async () =>
    (await T("nbfc_lsp_agreements")) ? ((await C("nbfc_lsp_agreements", "agreement_template_url")) ? "APPLIED" : "MISSING") : "N/A: table absent",
  "E-111a drop ai_call_logs_lead_id_fkey": async () =>
    (await CON("ai_call_logs_lead_id_fkey")) ? "MISSING (FK still present)" : "APPLIED (FK absent)",
  "E-111b nbfc_correction_rounds/items": async () =>
    (await T("nbfc_correction_rounds")) && (await T("nbfc_correction_items")) ? "APPLIED" : "MISSING",
  "E-112a dealer_leads.lead_status": async () =>
    (await C("dealer_leads", "lead_status")) ? "APPLIED" : "MISSING",
  "E-112b nbfc_lsp_agreement_signers.signing_status": async () =>
    (await T("nbfc_lsp_agreement_signers")) ? ((await C("nbfc_lsp_agreement_signers", "signing_status")) ? "APPLIED" : "MISSING") : "N/A: table absent",
  "E-113a lead_touchpoints": async () => (await T("lead_touchpoints")) ? "APPLIED" : "MISSING",
  "E-113b nbfc_loan_products.active_cities": async () =>
    (await T("nbfc_loan_products")) ? ((await C("nbfc_loan_products", "active_cities")) ? "APPLIED" : "MISSING") : "N/A: table absent",
  "E-114a lead_visits": async () => (await T("lead_visits")) ? "APPLIED" : "MISSING",
  "E-114b nbfc_loan_products.active_locations": async () =>
    (await T("nbfc_loan_products")) ? ((await C("nbfc_loan_products", "active_locations")) ? "APPLIED" : "MISSING") : "N/A: table absent",
  "E-115a lead_escalations": async () => (await T("lead_escalations")) ? "APPLIED" : "MISSING",
  "E-115b nbfc_loan_products.cibil_required": async () =>
    (await T("nbfc_loan_products")) ? ((await C("nbfc_loan_products", "cibil_required")) ? "APPLIED" : "MISSING") : "N/A: table absent",
  "E-116a dealer_lead_commercials": async () => (await T("dealer_lead_commercials")) ? "APPLIED" : "MISSING",
  "E-116b lead_products + lead_products.asset_type": async () =>
    (await T("lead_products")) ? ((await C("lead_products", "asset_type")) ? "APPLIED" : "PARTIAL: table yes, asset_type no") : "MISSING",
  "E-117a dealer_lead_status_history": async () => (await T("dealer_lead_status_history")) ? "APPLIED" : "MISSING",
  "E-117b widen score/loan refs (type change)": async () => "type-change — no simple sentinel",
  "E-118a asm_territories": async () => (await T("asm_territories")) ? "APPLIED" : "MISSING",
  "E-118b nbfc_buyback_requests": async () => (await T("nbfc_buyback_requests")) ? "APPLIED" : "MISSING",
  "E-119a nbfc_battery_evaluations": async () => (await T("nbfc_battery_evaluations")) ? "APPLIED" : "MISSING",
  "E-119b upload_batches": async () => (await T("upload_batches")) ? "APPLIED" : "MISSING",
  "E-120 assignment_config": async () => (await T("assignment_config")) ? "APPLIED" : "MISSING",
  "E-121 holiday_calendar": async () => (await T("holiday_calendar")) ? "APPLIED" : "MISSING",
  "E-122 duplicate_merge_requests": async () => (await T("duplicate_merge_requests")) ? "APPLIED" : "MISSING",
  "E-123 interest_level_overrides": async () => (await T("interest_level_overrides")) ? "APPLIED" : "MISSING",
  "E-124 user_preferences": async () => (await T("user_preferences")) ? "APPLIED" : "MISSING",
  "E-125 cost_currency default INR (default change)": async () => "default-change — no simple sentinel",
  "E-126 dealer_leads.source": async () => (await C("dealer_leads", "source")) ? "APPLIED" : "MISSING",
};

try {
  console.log("HOST:", new URL(url).hostname);
  console.log("=".repeat(64));
  for (const [label, fn] of Object.entries(checks)) {
    let res; try { res = await fn(); } catch (e) { res = "ERROR: " + (e.code || e.message); }
    const flag = res.startsWith("APPLIED") ? "✓" : res.startsWith("MISSING") || res.startsWith("PARTIAL") ? "✗" : "•";
    console.log(`${flag} ${label}\n    ${res}`);
  }
} finally { await sql.end(); }
