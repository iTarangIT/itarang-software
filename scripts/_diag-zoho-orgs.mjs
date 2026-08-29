// Diagnostic (read-only): why does the CEO dashboard show only ITG invoices?
// Probes three boundaries:
//   1. env      → which org ids the sync would iterate
//   2. Zoho API → per-org invoice count + any API error (incl. /organizations)
//   3. DB       → rows per organization_id in zoho_invoices
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Last assignment wins, matching `node --env-file` / dotenv. Must NOT be
// first-wins: process.env is case-insensitive on Windows, and .env.local keeps
// an older lowercase `zoho_client_id` block above the live uppercase one — a
// first-wins loader pairs the stale client id with the current refresh token
// and the token exchange fails with a misleading "invalid_code".
function loadEnv(p){ if(!existsSync(p))return; for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#"))continue;const i=t.indexOf("=");if(i<0)continue;const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[k]=v;}}
loadEnv(join(ROOT,".env.local"));
loadEnv(join(ROOT,".env"));

const REGION = process.env.ZOHO_REGION || "in";
const ACCOUNTS = `https://accounts.zoho.${REGION}`;
const API = `https://www.zohoapis.${REGION}/invoice/v3`;

async function token() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
  });
  const r = await fetch(`${ACCOUNTS}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const j = await r.json();
  if (!j.access_token) throw new Error(`token refresh failed ${r.status}: ${JSON.stringify(j)}`);
  return j.access_token;
}

async function api(tk, path, params = {}) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url.toString(), { headers: { Authorization: `Zoho-oauthtoken ${tk}` } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, json, text: text.slice(0, 300) };
}

console.log("=== 1. ENV ===");
console.log("ZOHO_ORGANIZATION_ID :", process.env.ZOHO_ORGANIZATION_ID || "(unset)");
console.log("ZOHO_ORGANIZATION_IDS:", process.env.ZOHO_ORGANIZATION_IDS || "(unset)");
const ids = (process.env.ZOHO_ORGANIZATION_IDS || process.env.ZOHO_ORGANIZATION_ID || "")
  .split(",").map(s => s.trim()).filter(Boolean);
console.log("sync would iterate  :", ids);

console.log("\n=== 2. ZOHO API ===");
let tk = null;
try {
  tk = await token();
  console.log("access token: OK");
} catch (e) {
  console.log("access token: FAILED —", e.message);
}

if (tk) {
  const orgs = await api(tk, "/organizations");
  if (orgs.json?.organizations) {
    for (const o of orgs.json.organizations) {
      console.log(`  org ${o.organization_id}  name="${o.name}"  status=${o.status ?? "?"}  default=${o.is_default_org}`);
    }
  } else {
    console.log("  /organizations ->", orgs.status, orgs.text);
  }

  for (const org of ids) {
    const r = await api(tk, "/invoices", { organization_id: org, page: 1, per_page: 200 });
    if (r.status !== 200) {
      console.log(`  org ${org}: HTTP ${r.status} :: ${r.text}`);
      continue;
    }
    const inv = r.json?.invoices ?? [];
    const nums = inv.slice(0, 3).map(i => i.invoice_number).join(", ");
    const dates = inv.map(i => i.date).filter(Boolean).sort();
    console.log(`  org ${org}: page1=${inv.length} has_more=${!!r.json?.page_context?.has_more_page} sample=[${nums}] range=${dates[0] ?? "-"}..${dates[dates.length-1] ?? "-"}`);
  }
}

// `--prod` points the DB probe at database-2 (the commented prod block in
// .env.local) instead of the default dev DB. Read-only either way.
let dbUrl = process.env.DATABASE_URL;
if (process.argv.includes("--prod")) {
  const line = readFileSync(join(ROOT, ".env.local"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith("# DATABASE_URL=") && l.includes("database-2"));
  if (!line) { console.log("no commented prod DATABASE_URL found"); process.exit(1); }
  dbUrl = line.replace(/^#\s*DATABASE_URL=/, "").trim();
}
console.log(`\n=== 3. DB (zoho_invoices) — ${dbUrl.includes("database-2") ? "PROD database-2" : "dev database-1"} ===`);
const sql = postgres(dbUrl, { ssl: { rejectUnauthorized: false }, max: 1 });
const byOrg = await sql`
  SELECT organization_id, COUNT(*)::int AS n,
         MIN(invoice_date) AS first_date, MAX(invoice_date) AS last_date,
         SUM(total)::numeric AS total_sum, MAX(synced_at) AS last_synced
  FROM zoho_invoices GROUP BY 1 ORDER BY 2 DESC`;
console.table([...byOrg]);

const byPrefix = await sql`
  SELECT split_part(invoice_number, '/', 1) AS prefix, COUNT(*)::int AS n, MAX(invoice_date) AS last_date
  FROM zoho_invoices GROUP BY 1 ORDER BY 2 DESC LIMIT 15`;
console.log("-- invoice_number prefixes --");
console.table([...byPrefix]);

const state = await sql`SELECT * FROM zoho_sync_state WHERE id = 1`;
console.log("-- zoho_sync_state --");
console.log(state[0] ?? "(no row)");

// Ages in plain minutes/hours. "Is the sync still ticking?" is the question the
// raw timestamps above make you do arithmetic for, and getting it wrong sends
// you hunting a data bug when the real fault is that nothing is running at all.
const age = (t) => {
  if (!t) return "never";
  const mins = (Date.now() - new Date(t).getTime()) / 60000;
  if (mins < 90) return `${mins.toFixed(0)}m ago`;
  const hrs = mins / 60;
  return hrs < 48 ? `${hrs.toFixed(1)}h ago` : `${(hrs / 24).toFixed(1)} days ago`;
};
console.log("\n-- AGES (hourly ticker => everything below should be <60m) --");
console.log(`  zoho_sync_state.last_run_at : ${age(state[0]?.last_run_at)}   status=${state[0]?.last_status ?? "?"}`);
for (const r of byOrg) {
  console.log(`  org ${r.organization_id ?? "(NULL)"} last_synced : ${age(r.last_synced)}   rows=${r.n} latest_invoice=${r.last_date ?? "-"}`);
}
console.log(
  "\n  last_run_at fresh but an org stale  -> that org's pull is failing (see last_error)\n" +
  "  last_run_at ALSO stale              -> nothing is running: ticker dead or deploy never landed",
);
await sql.end();
