// Applies drizzle/E-170 (dead Supabase links -> /api/files) to the DB in DATABASE_URL.
// Refuses unless the host is the one named on the command line. Saves a snapshot first.
import pg from "pg";
import { readFileSync, writeFileSync } from "node:fs";
const want = process.argv[2];
const snapPath = process.argv[3];
const host = new URL(process.env.DATABASE_URL).host.split(".")[0];
if (host !== want) { console.error(`DATABASE_URL is ${host}, expected ${want}`); process.exit(1); }
const sql = readFileSync("drizzle/E-170_backfill_storage_urls_to_files_proxy.sql", "utf8");
const cols = [["ai_call_logs","recording_url"],["consent_records","generated_pdf_url"],["consent_records","signed_consent_url"],["dealer_onboarding_applications","signed_agreement_url"],["dealer_onboarding_applications","audit_trail_url"],["dealer_onboarding_documents","file_url"],["kyc_documents","file_url"],["other_document_requests","file_url"],["expense_submissions","bill_url"],["lead_touchpoints","recording_url"],["product_selections","battery_photo_urls"],["product_selections","charger_photo_urls"]];
const RE = `https?://[^/]+/storage/v1/object/public/(documents|dealer-documents|call-recordings)/`;
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const count = async () => { const out = {}; for (const [t, k] of cols) { try { const r = await c.query(`select count(*)::int n from "${t}" where "${k}"::text ~ $1`, [RE]); out[`${t}.${k}`] = r.rows[0].n; } catch (e) { out[`${t}.${k}`] = "missing"; } } return out; };
const before = await count();
console.log("host", host, "BEFORE", before);
const snap = {};
for (const [t, k] of cols) { try { snap[`${t}.${k}`] = (await c.query(`select ctid::text, "${k}"::text v, (select row_to_json(x) from (select * from "${t}" limit 0) x) _ , * from "${t}" where "${k}"::text ~ $1`, [RE])).rows.map(r => ({ id: r.id ?? null, value: r.v })); } catch {} }
writeFileSync(snapPath, JSON.stringify({ host, at: new Date().toISOString(), snap }, null, 1));
console.log("snapshot ->", snapPath);
await c.query("BEGIN");
await c.query(sql);
const after = await count();
const left = Object.values(after).filter(v => typeof v === "number").reduce((a, b) => a + b, 0);
if (left !== 0) { await c.query("ROLLBACK"); console.error("ROLLED BACK, still left:", after); process.exit(1); }
await c.query("COMMIT");
console.log("AFTER", after);
await c.query(sql); // re-run must be a no-op
console.log("AFTER re-run", await count());
await c.end();
