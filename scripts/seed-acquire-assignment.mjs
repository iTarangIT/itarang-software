/**
 * Seed an nbfc_lead_assignments row so a lead appears in an NBFC's Acquire
 * queue for testing — mirrors what submit-product-selection's fan-out creates
 * (incl. the service-config snapshot). For local/test use only.
 *
 *   node scripts/seed-acquire-assignment.mjs <LEAD_ID> [nbfcMatch=electro] [--selected]
 *
 *   <LEAD_ID>     a finance lead id
 *   nbfcMatch     substring matched against nbfc.short_name/legal_name (default 'electro')
 *   --selected    set status='selected' (winner) so the E-NACH track activates
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = (process.env.DATABASE_URL ||
  readFileSync(join(root, ".env.local"), "utf8").match(/^\s*DATABASE_URL\s*=\s*(.+)$/m)[1]).replace(/^["']|["']$/g, "");

const args = process.argv.slice(2);
const leadId = args.find((a) => !a.startsWith("--") && a !== "electro") ?? args[0];
const selected = args.includes("--selected");
const nbfcMatch = args.find((a) => !a.startsWith("--") && a !== leadId) ?? "electro";

if (!leadId) {
  console.error("Usage: node scripts/seed-acquire-assignment.mjs <LEAD_ID> [nbfcMatch] [--selected]");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });

const [nbfcRow] = await sql`
  SELECT id, short_name, legal_name, tenant_id FROM nbfc
  WHERE (short_name ILIKE ${"%" + nbfcMatch + "%"} OR legal_name ILIKE ${"%" + nbfcMatch + "%"})
  ORDER BY id LIMIT 1`;
if (!nbfcRow) { console.error(`No nbfc matching '${nbfcMatch}'`); await sql.end(); process.exit(1); }
if (!nbfcRow.tenant_id) {
  console.error(`nbfc id=${nbfcRow.id} (${nbfcRow.short_name}) has NULL tenant_id — repoint it first; the Acquire queue is tenant-scoped.`);
  await sql.end(); process.exit(1);
}

const [cfg] = await sql`SELECT * FROM nbfc_service_config WHERE tenant_id = ${nbfcRow.tenant_id} LIMIT 1`;
const snapshot = {
  fi_enabled: cfg?.fi_enabled ?? false,
  vkyc_enabled: cfg?.vkyc_enabled ?? false,
  vkyc_mode: cfg?.vkyc_mode ?? null,
  enach_enabled: cfg?.enach_enabled ?? false,
  enach_handoff_method: cfg?.enach_handoff_method ?? null,
  doc_agreement_method: cfg?.doc_agreement_method ?? null,
  store_sanction_letter: cfg?.store_sanction_letter ?? false,
  store_loan_agreement: cfg?.store_loan_agreement ?? false,
  track_completion_gate: cfg?.track_completion_gate ?? true,
  track_failure_halts: cfg?.track_failure_halts ?? false,
  captured_at: new Date().toISOString(),
};
const status = selected ? "selected" : "pending";

await sql`
  INSERT INTO nbfc_lead_assignments (lead_id, nbfc_id, tenant_id, status, service_config_snapshot)
  VALUES (${leadId}, ${nbfcRow.id}, ${nbfcRow.tenant_id}, ${status}, ${sql.json(snapshot)})
  ON CONFLICT (lead_id, nbfc_id)
  DO UPDATE SET status = ${status}, service_config_snapshot = ${sql.json(snapshot)}, updated_at = now()`;

console.log(`Seeded assignment: lead=${leadId} → nbfc=${nbfcRow.id} (${nbfcRow.short_name}) tenant=${nbfcRow.tenant_id} status=${status}`);
console.log(cfg ? "Service config snapshot taken from current opt-in toggles." : "No service_config row yet — snapshot is all-OFF; enable services in /nbfc/settings then re-run.");
await sql.end({ timeout: 5 });
