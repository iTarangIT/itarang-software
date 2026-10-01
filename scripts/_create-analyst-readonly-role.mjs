// One-off: create / update the read-only Postgres login the AI Analyst uses for the
// "iTarang database" source (ANALYST_CRM_READONLY_DSN). Idempotent — re-running re-applies the
// grants, so changing ALLOWED below and running again is how the list is changed.
//
//   ANALYST_RO_PASSWORD=<strong password> node --env-file=.env.local scripts/_create-analyst-readonly-role.mjs
//   (.env.local = database-1 = sandbox; .env.production = database-2 = prod)
//
// Why an allowlist: the analyst sends query results to an LLM (Gemini). KYC, documents,
// credentials, auth, OTPs, bank statements, WhatsApp/assistant messages and per-person PII
// tables are therefore NOT readable through this login. The agent also forces read-only
// sessions and its own SQL guard; this is the database-side backstop.
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

const url = process.env.DATABASE_URL;
const password = process.env.ANALYST_RO_PASSWORD;
if (!url) throw new Error("DATABASE_URL is not set");
if (!password || password.length < 16) throw new Error("set ANALYST_RO_PASSWORD (16+ characters)");

const target = new URL(url);
console.log("target:", target.host, target.pathname);

const sql = postgres(url, { max: 1, ssl: "require", onnotice: (n) => console.log("  notice:", n.message) });
const ident = (s) => `"${s.replace(/"/g, '""')}"`;
const literal = (s) => `'${s.replace(/'/g, "''")}'`;

const exists = await sql`select 1 from pg_roles where rolname = ${ROLE}`;
// RDS refuses any ALTER that names the SUPERUSER attribute, so an existing role only has its
// password and limits reset.
await sql.unsafe(
  exists.length
    ? `ALTER ROLE ${ident(ROLE)} WITH LOGIN NOINHERIT CONNECTION LIMIT 5 PASSWORD ${literal(password)}`
    : `CREATE ROLE ${ident(ROLE)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 5 PASSWORD ${literal(password)}`,
);
console.log(exists.length ? "role updated" : "role created");

const db = target.pathname.replace(/^\//, "") || "postgres";
await sql.unsafe(`ALTER ROLE ${ident(ROLE)} SET default_transaction_read_only = on`);
await sql.unsafe(`ALTER ROLE ${ident(ROLE)} SET statement_timeout = '8s'`);
await sql.unsafe(`ALTER ROLE ${ident(ROLE)} SET idle_in_transaction_session_timeout = '30s'`);
await sql.unsafe(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${ident(ROLE)}`);
await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${ident(ROLE)}`);
// Start from nothing, so a table taken off ALLOWED loses its grant on the next run.
await sql.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ident(ROLE)}`);
await sql.unsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${ident(ROLE)}`);

const present = new Set(
  (
    await sql`select table_name from information_schema.tables
               where table_schema = 'public' and table_name in ${sql(ALLOWED)}`
  ).map((r) => r.table_name),
);
for (const table of ALLOWED.filter((t) => present.has(t))) {
  await sql.unsafe(`GRANT SELECT ON public.${ident(table)} TO ${ident(ROLE)}`);
}
const missing = ALLOWED.filter((t) => !present.has(t));
console.log(`granted SELECT on ${present.size} tables`);
if (missing.length) console.log("not in this database (skipped):", missing.join(", "));
await sql.end();

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
await ro.end();
console.log({ default_transaction_read_only: readonly, readable_tables: n, write_blocked: writeBlocked, users_blocked: piiBlocked });
console.log("\nANALYST_CRM_READONLY_DSN=postgresql://analyst_ro:<password>@" + target.host + target.pathname + "?sslmode=require");
