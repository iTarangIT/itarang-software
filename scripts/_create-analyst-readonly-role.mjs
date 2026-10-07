// One-off: create / update the read-only Postgres login the AI Analyst uses for the
// "iTarang database" source (ANALYST_CRM_READONLY_DSN). Idempotent — re-running re-applies the
// grants, so changing ALLOWED below and running again is how the list is changed.
//
//   ANALYST_RO_PASSWORD=<strong password> node --env-file=.env.local scripts/_create-analyst-readonly-role.mjs
//   (the script prints the host it is about to change — check it is the database you mean)
//
//   node --env-file=.env.local scripts/_create-analyst-readonly-role.mjs
//   with NO password, on a database where the role already exists: re-applies the grants and
//   leaves the password alone — so the analyst's saved connection keeps working. This is how
//   to tighten what the role can read without touching ANALYST_CRM_READONLY_DSN.
//
//   DRY_RUN=1 node --env-file=.env.local scripts/_create-analyst-readonly-role.mjs
//   changes nothing and needs no password: prints whether the role exists, what it can read
//   today, and the columns the next real run would withhold.
//
// Why an allowlist: the analyst sends query results to an LLM (Gemini). KYC, documents,
// credentials, auth, OTPs, bank statements, WhatsApp/assistant messages and per-person PII
// tables are therefore NOT readable through this login. The agent also forces read-only
// sessions and its own SQL guard; this is the database-side backstop.
//
// Tracker ID 118: a table on the list used to be granted WHOLE, so the login could still read
// leads.dob, leads.kyc_draft_data (full Aadhaar / PAN), addresses, phone numbers and call
// transcripts. A table with any column matching WITHHELD below is now granted column by
// column, without those. On such a table `select *` is refused — the agent has to name
// columns, and its schema listing only shows the ones it may read. A column added to such a
// table later is unreadable until this script is run again.
import postgres from "postgres";

const ROLE = "analyst_ro";

const ALLOWED = [
  // leads & sales pipeline
  "leads", "lead_assignments", "lead_flow_events", "lead_products", "lead_visits", "lead_touchpoints",
  "lead_escalations", "dealer_leads", "dealer_lead_status_history", "deals", "dealers",
  "dealer_subscriptions", "sales_targets", "manual_dealer_sales", "asm_territories", "region_groups",
  "states", "cities",
  // AI dialer & campaigns
  "campaigns", "campaign_segments", "dialer_campaigns", "dialer_campaign_leads", "ai_call_logs",
  "bolna_calls", "call_records", "call_sessions", "ecofy_leads", "ecofy_lead_activities",
  // scraper
  "scraper_leads", "scraped_dealer_leads", "scraper_runs",
  // revenue, orders, expenses
  "invoices", "invoice_lines", "zoho_invoices", "sales_invoices", "proforma_invoices",
  "proforma_invoice_lines", "orders", "purchase_orders", "purchase_order_lines", "expense_submissions",
  // inventory & products
  "inventory", "inventory_events", "inventory_transfers", "products", "product_categories",
  "product_master_batteries", "product_master_chargers", "deployed_assets", "after_sales_records",
  "service_tickets", "oems",
  // buyback
  "buyback_requests", "buyback_deals", "buyback_lines", "buyback_units", "buyback_batches", "pickups",
  // fleet
  "battery_alerts", "telemetry_daily_summary", "device_battery_map", "battery_spec_models",
  // usage
  "module_usage_daily",
];

// Column names withheld on every allowed table: what identifies or locates a person, their
// bank and tax ids, raw call content, and unparsed provider payloads (which carry all of it).
const WITHHELD = [
  /phone|mobile|whatsapp/,
  /(^|_)contact(_|$)/,
  /email/,
  /(^|_)dob(_|$)|birth/,
  /father|husband|mother|spouse/,
  /customer_name|full_name|vehicle_owner_name/,
  /aadhaar|aadhar/,
  /(^|_)pan(_|$)/,
  /gstin|gst_number/,
  /address/,
  /(^|_)(lat|lng|latitude|longitude)(_|$)/,
  /bank|ifsc|beneficiary/,
  /transcript/,
  /recording/,
  /(^|_)raw(_|$)|payload|draft/,
  /photo|selfie|signature|document_url|proof_url/,
];
// Matches above that are not personal data: flags, counters, ids, city centroids.
const KEPT = new Set([
  "phone_quality", "phone_valid", "new_leads_skipped_invalid_phone", "answered_by_voicemail", "transcript_fetched_at",
  "pickup_address_id", "cities.lat", "cities.lng",
]);
const withheld = (table, column) =>
  !KEPT.has(column) && !KEPT.has(`${table}.${column}`) && WITHHELD.some((re) => re.test(column));

const dryRun = /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? "");
const url = process.env.DATABASE_URL;
const password = process.env.ANALYST_RO_PASSWORD;
if (!url) throw new Error("DATABASE_URL is not set");
if (password && password.length < 16) throw new Error("ANALYST_RO_PASSWORD must be 16+ characters");

const target = new URL(url);
console.log("target:", target.host, target.pathname);

const sql = postgres(url, { max: 1, ssl: "require", onnotice: (n) => console.log("  notice:", n.message) });
const ident = (s) => `"${s.replace(/"/g, '""')}"`;
const literal = (s) => `'${s.replace(/'/g, "''")}'`;

const exists = await sql`select 1 from pg_roles where rolname = ${ROLE}`;

// Every allowed table that exists here, with the columns to grant and to withhold.
const plan = new Map();
for (const r of await sql`select table_name, column_name from information_schema.columns
                           where table_schema = 'public' and table_name in ${sql(ALLOWED)}
                           order by table_name, ordinal_position`) {
  if (!plan.has(r.table_name)) plan.set(r.table_name, { grant: [], withhold: [] });
  plan.get(r.table_name)[withheld(r.table_name, r.column_name) ? "withhold" : "grant"].push(r.column_name);
}

if (dryRun) {
  console.log(exists.length ? `role ${ROLE} exists` : `role ${ROLE} does NOT exist in this database`);
  const whole = await sql`select table_name from information_schema.table_privileges
                           where grantee = ${ROLE} and table_schema = 'public' and privilege_type = 'SELECT'`;
  console.log(`readable in full today: ${whole.length} table(s)`);
  console.log("a real run would withhold:");
  for (const [table, p] of plan) if (p.withhold.length) console.log(`  ${table}: ${p.withhold.join(", ")}`);
  console.log("DRY_RUN — nothing was changed");
  await sql.end();
  process.exit(0);
}

// RDS refuses any ALTER that names the SUPERUSER attribute, so an existing role only has its
// password and limits reset.
if (!exists.length && !password) {
  await sql.end();
  throw new Error(`role ${ROLE} does not exist here — set ANALYST_RO_PASSWORD (16+ characters) to create it`);
}
// No password given = keep the one the analyst's saved connection uses.
const withPassword = password ? ` PASSWORD ${literal(password)}` : "";
await sql.unsafe(
  exists.length
    ? `ALTER ROLE ${ident(ROLE)} WITH LOGIN NOINHERIT CONNECTION LIMIT 5${withPassword}`
    : `CREATE ROLE ${ident(ROLE)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 5${withPassword}`,
);
console.log(!exists.length ? "role created" : password ? "role updated" : "role kept (password unchanged)");

const db = target.pathname.replace(/^\//, "") || "postgres";
await sql.unsafe(`ALTER ROLE ${ident(ROLE)} SET default_transaction_read_only = on`);
await sql.unsafe(`ALTER ROLE ${ident(ROLE)} SET statement_timeout = '8s'`);
await sql.unsafe(`ALTER ROLE ${ident(ROLE)} SET idle_in_transaction_session_timeout = '30s'`);
await sql.unsafe(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${ident(ROLE)}`);
await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${ident(ROLE)}`);
// Start from nothing, so a table taken off ALLOWED loses its grant on the next run.
await sql.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ident(ROLE)}`);
await sql.unsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${ident(ROLE)}`);

// (Revoking a table's SELECT above also revoked any column grants from an earlier run.)
let firstWithheld = null;
for (const [table, p] of plan) {
  if (!p.withhold.length) {
    await sql.unsafe(`GRANT SELECT ON public.${ident(table)} TO ${ident(ROLE)}`);
  } else if (p.grant.length) {
    await sql.unsafe(`GRANT SELECT (${p.grant.map(ident).join(", ")}) ON public.${ident(table)} TO ${ident(ROLE)}`);
    firstWithheld ??= { table, column: p.withhold[0] };
    console.log(`  ${table}: withheld ${p.withhold.join(", ")}`);
  }
}
const missing = ALLOWED.filter((t) => !plan.has(t));
console.log(`granted SELECT on ${plan.size} tables`);
if (missing.length) console.log("not in this database (skipped):", missing.join(", "));
await sql.end();

// Verify. With the password: on a fresh connection as the role itself. Without it (grants-only
// run): from the catalogue, which is where the role's privileges are recorded.
if (!password) {
  const admin = postgres(url, { max: 1, ssl: "require" });
  const [{ whole }] = await admin`select count(*)::int as whole from information_schema.table_privileges
                                   where grantee = ${ROLE} and table_schema = 'public' and privilege_type = 'SELECT'`;
  const [{ partial }] = await admin`select count(distinct table_name)::int as partial from information_schema.column_privileges
                                     where grantee = ${ROLE} and table_schema = 'public' and privilege_type = 'SELECT'`;
  let withheldReadable = null;
  if (firstWithheld) {
    const [r] = await admin`select has_column_privilege(${ROLE}, ${"public." + firstWithheld.table}, ${firstWithheld.column}, 'SELECT') as ok`;
    withheldReadable = r.ok;
  }
  const [u] = await admin`select has_table_privilege(${ROLE}, 'public.users', 'SELECT') as ok`;
  await admin.end();
  console.log({
    tables_readable_in_full: whole,
    tables_with_any_readable_column: partial,
    users_blocked: !u.ok,
    withheld_column_blocked: withheldReadable === null ? true : !withheldReadable,
  });
  console.log("\npassword unchanged — ANALYST_CRM_READONLY_DSN stays as it is");
  process.exit(0);
}

// Verify on a fresh connection as the role itself.
const roUrl = new URL(url);
roUrl.username = ROLE;
roUrl.password = password;
const ro = postgres(roUrl.toString(), { max: 1, ssl: "require" });
const [{ readonly }] = await ro`show default_transaction_read_only`.then((r) => [{ readonly: r[0].default_transaction_read_only }]);
const [{ n }] = await ro`select count(distinct table_name)::int as n from information_schema.table_privileges
                          where grantee = current_user and table_schema = 'public' and privilege_type = 'SELECT'`;
let writeBlocked = false;
try {
  await ro`create temp table _analyst_probe (x int)`;
} catch {
  writeBlocked = true;
}
let piiBlocked = false;
try {
  await ro`select 1 from users limit 1`;
} catch {
  piiBlocked = true;
}
let columnBlocked = firstWithheld === null;
if (firstWithheld) {
  try {
    await ro.unsafe(`select ${ident(firstWithheld.column)} from public.${ident(firstWithheld.table)} limit 1`);
  } catch {
    columnBlocked = true;
  }
}
await ro.end();
console.log({
  default_transaction_read_only: readonly,
  readable_tables: n,
  write_blocked: writeBlocked,
  users_blocked: piiBlocked,
  withheld_column_blocked: columnBlocked,
});
console.log("\nANALYST_CRM_READONLY_DSN=postgresql://analyst_ro:<password>@" + target.host + target.pathname + "?sslmode=require");
