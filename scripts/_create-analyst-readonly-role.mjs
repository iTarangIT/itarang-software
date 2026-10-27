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
//
// Tracker ID 167 (10 Oct): the analyst still reached customer PII through free text and names
// the patterns missed (leads.owner_name, vehicle RC, remarks / notes / call summaries, Ecofy's
// `snapshot` jsonb with the whole case). Now also withheld: person names, vehicle numbers,
// every remark / note / comment / summary / feedback column, provider snapshots, loan / account
// numbers and pincodes (address = city only). Ecofy's customer table is no longer granted at
// all: the analyst reads `analyst_ecofy_leads`, a view that shows each customer as
// "Customer #<code>" (the same code every time, from the row id), city and state only, and no
// phone, email, address, pincode, case number, link or snapshot. Customer loan files are read
// the same way (Apoorv via Kartik, 10 Oct): `analyst_loan_files` and `analyst_loan_applications`
// show "Customer #<code>", the customer's city and state only, the amounts, dates and statuses —
// no name, co-borrower, NBFC reference / loan account number, disbursal reference, EMI schedule
// or rejection text. The base tables (and loan_sanctions, nbfc_loans, …) stay off ALLOWED.
//
// Tracker ID 167 (18 Oct rework, sheet rows 14 / 51–66): the block list now also covers
// dealer / shop names (company names stay), location and area, family, every reason column,
// AI signals / score breakdown / intent details, memory and call-note history, attachments,
// file links (*_url / *_uri / website / map ids), stored-file keys (S3, storage, Drive ids, file
// names, folder paths), payment references and transaction ids, e-sign ids and errors, call
// outcomes and attempt history, NeoDove agent / tag / stage, suggested actions and CEO
// recommendations, deployment location and telemetry blobs, expense vendors and the names of
// whoever uploaded / created / acted on a row. The `leads` table (individual borrowers) is no
// longer granted: `analyst_leads` shows each borrower as "Customer #<code>", city and state, no
// phone / ID / loan account numbers and no free text. The code is an md5 of the lead id, so it
// is NOT the lead id: the loan views carry the same code instead of lead_id — they join to each
// other and to analyst_leads, never back to a lead id. analyst_ecofy_leads drops staff names,
// preferred call time and closure reason. `accounts` / `account_closures` are granted (GSTIN,
// PAN, bank, contact and address withheld) for live-dealer counts, with `analyst_account_flags`
// giving each account's GSTIN-missing / is-dealer answer without the GSTIN itself, and
// `analyst_staff` (user id, name, role, active — nothing else from `users`) for the idle rule's
// ASM / ISR limit and per-rep questions (27 Oct: name added; phone, email and auth stay blocked).
// time_limit_settings and holiday_calendar are granted for the same rule.
// After every run: press "Refresh tables" in the Analyst's iTarang database source, so the
// withheld columns drop out of its table list.
import postgres from "postgres";

const ROLE = "analyst_ro";

const ALLOWED = [
  // leads & sales pipeline (the borrower `leads` table is read through analyst_leads, below)
  "lead_assignments", "lead_flow_events", "lead_products", "lead_visits", "lead_touchpoints",
  "lead_escalations", "dealer_leads", "dealer_lead_status_history", "deals", "dealers",
  "dealer_subscriptions", "sales_targets", "sales_target_versions", "manual_dealer_sales", "asm_territories", "region_groups",
  // ID 155 — who reported to whom on a date (dated teams; its free-text reason stays withheld)
  "user_reporting_lines",
  "states", "cities",
  // AI dialer & campaigns
  "campaigns", "campaign_segments", "dialer_campaigns", "dialer_campaign_leads", "ai_call_logs",
  "bolna_calls", "call_records", "call_sessions", "ecofy_lead_activities",
  // scraper
  "scraper_leads", "scraped_dealer_leads", "scraper_runs",
  // revenue, orders, expenses
  "invoices", "invoice_lines", "zoho_invoices", "sales_invoices", "proforma_invoices",
  "proforma_invoice_lines", "orders", "purchase_orders", "purchase_order_lines", "expense_submissions",
  // ID 32 — what the metric rules (src/lib/reports/metricDefinitions.ts ANALYST_RULES) name:
  // voids, credit notes, invoice item lines, item → product mapping, quotes and who owned an
  // account on a date. Their GSTIN / customer-name / raw columns stay withheld by WITHHELD.
  "invoice_voids", "credit_notes", "invoice_line_items", "vyapar_item_map", "dealer_lead_commercials",
  "account_owner_history",
  // ID 148 — live dealer counts: closed accounts (account_closures) leave them; owner per account.
  "accounts", "account_closures", "account_ownership",
  // ID 192 — the idle rule's limits (idle_cc / idle_asm) and the holidays it skips.
  "time_limit_settings", "holiday_calendar",
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
  // ID 167 — person names, vehicle numbers, free text, snapshots, account numbers, pincodes
  /owner_name|proprietor|contact_person|person_name/,
  /vehicle_(rc|no|number|reg)|(^|_)rc(_|$)|registration_no|chassis|engine_no/,
  /remark|(^|_)notes?(_|$)|comment|(^|_)summary$|conversation|feedback|issue_description|message_content|(^|_)description$/,
  /snapshot|last_change/,
  /loan_account|account_no(_|$)|account_number/,
  /pincode|pin_code/,
  // ID 167 (18 Oct) — sheet rows 51–64.
  // names of a dealer's shop or of a person (company names — business_entity_name,
  // company_name, oem_name — stay: they are what a dealer count is grouped by)
  /dealer_name|shop_name|business_name|_by_name$|agent_name|actor_label/,
  // where a dealer or a customer is, beyond city / state
  /(^|_)location$|(^|_)area$|google_place|maps|(^|_)website$/,
  /family/,
  // every reason (lost, expiry, rejection, transfer, cancellation, attention, consent, intent …)
  /reason/,
  // what the AI or a rep wrote or remembered about a dealer
  /intent_details|(^|_)signals$|score_breakdown|memory|history$|interested_in|call_outcome$/,
  /suggested_action|recommendation$/,
  /external_(agent|tag|stage)/,
  /attachment/,
  // file links and stored files
  /(^|_)(url|uri|link)$|qr_code/,
  // ID 166 (18 Oct): also `original_filename` and any other *filename column.
  /(^|_)s3(_|$)|storage_(key|path)|drive_(file|row)|file_?name|folder_path/,
  // payment / e-sign / provider references and errors
  /reference|(^|_)ref$|transaction_id|esign_(certificate|error)|ocr_error/,
  // provider blobs and expense payees
  /telemetry_data|(^|_)metadata$|(^|_)vendor$/,
];
// Column-specific withholdings the patterns above cannot name without catching too much.
const WITHHELD_COLUMNS = new Set([
  "scraper_leads.name", // the scraped dealer's name
  "manual_dealer_sales.uploaded_by", // free-text name of whoever uploaded the sheet
  "dealer_lead_commercials.dealer_decision_actor", // the dealer's person who accepted a quote
]);
// Matches above that are not personal data: flags, counters, ids, city centroids, coded values.
const KEPT = new Set([
  "phone_quality", "phone_valid", "new_leads_skipped_invalid_phone", "answered_by_voicemail", "transcript_fetched_at",
  "pickup_address_id", "cities.lat", "cities.lng",
  // configuration text written by staff, not about a customer
  "campaign_segments.description", "region_groups.description",
  // ID 184 — why a lead became sales-ready: a fixed code (salesReady.ts SALES_READY_REASONS)
  "sales_ready_reason",
  // ID 169 — why a lead was lost: a fixed code (transitions.ts LOST_REASON); lost_reason_notes stays withheld
  "dealer_leads.lost_reason",
  // a warehouse is ours, not a customer's
  "inventory.warehouse_location",
]);
const withheld = (table, column) =>
  WITHHELD_COLUMNS.has(`${table}.${column}`) ||
  (!KEPT.has(column) && !KEPT.has(`${table}.${column}`) && WITHHELD.some((re) => re.test(column)));

// ID 167 — masked views the analyst reads in place of a customer table. The view runs with
// its owner's rights, so the role needs no grant on the base table. A view is dropped and
// re-created on every run (CREATE OR REPLACE cannot drop a column), then granted again.
//
// The customer code (18 Oct): "Customer #" + the first 8 hex digits of md5(lead id), upper-
// cased — the same code for the same borrower in analyst_leads, analyst_loan_files and
// analyst_loan_applications, so they join to each other on `customer`, but it is not the lead
// id and nothing granted maps it back to one. Ecofy keeps its own code (from its row id).
const customerCode = (expr) => `'Customer #' || upper(left(md5((${expr})::text), 8))`;

// analyst_leads: every `leads` column withheld() leaves, minus the ids that would map a
// borrower back to a lead (its own id, the deal it became, its upload / scrape batch, the
// reference id) — so the list follows the database the script runs on.
const LEADS_VIEW_LEFT_OUT = new Set(["id", "converted_deal_id", "reference_id", "uploader_id", "scrape_batch_id", "scrape_query"]);

// iTarang's own GSTINs (src/lib/leads/gstin.ts ITARANG_GSTINS) — never a customer's.
const ITARANG_GSTINS = ["06AALFI7813E1ZE", "07AALFI7813E1ZC"];
// SQL twin of gstinMissingSql() (src/lib/accounts/accountList.ts, via src/lib/leads/gstinMatch.ts
// GSTIN_KEY + gstinKeyIsMatchable): NULL, blank, 'PENDING', bad shape, bad mod-36 check
// character, or one of iTarang's own. `k` is the normalised key. Keep in step with those.
const GSTIN_MATCHABLE = (k) => `(CASE WHEN ${k} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$'
                 AND ${k} NOT IN (${ITARANG_GSTINS.map((g) => `'${g}'`).join(", ")})
             THEN (SELECT substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                                 ((36 - (sum(gm_p / 36 + gm_p % 36) % 36)) % 36)::int + 1, 1)
                     FROM (SELECT (strpos('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', substr(${k}, gm_i, 1)) - 1)
                                  * (CASE WHEN gm_i % 2 = 1 THEN 1 ELSE 2 END) AS gm_p
                             FROM generate_series(1, 14) AS gm_i) gm_digits) = substr(${k}, 15, 1)
             ELSE FALSE END)`;

// `sql(columns)` gets the base table's columns in this database.
const MASKED_VIEWS = [
  {
    name: "analyst_leads",
    base: "leads",
    sql: (cols) => `CREATE VIEW public.analyst_leads AS
      SELECT ${customerCode("l.id")} AS customer,
             ${cols.filter((c) => !LEADS_VIEW_LEFT_OUT.has(c) && !withheld("leads", c)).map((c) => `l.${ident(c)}`).join(", ")}
        FROM public.leads l`,
  },
  {
    name: "analyst_ecofy_leads",
    base: "ecofy_leads",
    // 18 Oct: no staff names (owner, qualified_by_name), preferred call time or closure reason
    sql: () => `CREATE VIEW public.analyst_ecofy_leads AS
      SELECT id,
             'Customer #' || left(replace(id::text, '-', ''), 8) AS customer,
             stage, sub_status, segment, temperature, lead_source,
             queue_entered_at, product_interest, avg_monthly_bill_inr, sanctioned_load_kw,
             existing_backup, customer_type, city, state,
             preferred_language, property_type, last_event_type, last_event_at,
             assigned_to_user_id, assigned_role, assigned_at, next_follow_up_at,
             next_appointment_at, created_at, updated_at
        FROM public.ecofy_leads`,
  },
  {
    name: "analyst_loan_files",
    base: "loan_files",
    // 18 Oct: no lead_id — the customer code stands in for it
    sql: () => `CREATE VIEW public.analyst_loan_files AS
      SELECT f.id,
             ${customerCode("coalesce(f.lead_id::text, f.id::text)")} AS customer,
             f.loan_application_id, f.dealer_id, l.city, l.state,
             f.loan_amount, f.interest_rate, f.tenure_months, f.emi_amount, f.down_payment,
             f.processing_fee, f.disbursal_status, f.disbursed_amount, f.disbursed_at, f.total_paid,
             f.total_outstanding, f.next_emi_date, f.overdue_amount, f.overdue_days, f.loan_status,
             f.closure_date, f.closure_type, f.created_at, f.updated_at
        FROM public.loan_files f
        LEFT JOIN public.leads l ON l.id::text = f.lead_id::text`,
  },
  {
    name: "analyst_loan_applications",
    base: "loan_applications",
    // 18 Oct: no lead_id — the customer code stands in for it
    sql: () => `CREATE VIEW public.analyst_loan_applications AS
      SELECT a.id,
             ${customerCode("coalesce(a.lead_id::text, a.id::text)")} AS customer,
             a.dealer_id, l.city, l.state,
             a.loan_amount, a.interest_rate, a.tenure_months, a.emi_amount, a.down_payment,
             a.facilitation_fee, a.facilitation_fee_status, a.facilitation_fee_amount, a.documents_uploaded,
             a.status, a.application_status, a.company_validation_status, a.nbfc_name,
             a.submitted_at, a.approved_at, a.disbursed_at, a.created_at, a.updated_at
        FROM public.loan_applications a
        LEFT JOIN public.leads l ON l.id::text = a.lead_id::text`,
  },
  {
    // ID 148 — the GSTIN-missing and is-a-dealer answers per account, without the GSTIN
    // (accounts.gstin is withheld). is_dealer = dealerAccountSql(): every account except a
    // scrap-vendor entity with no dealer onboarding behind it.
    name: "analyst_account_flags",
    base: "accounts",
    sample: "gstin_missing",
    sql: () => `CREATE VIEW public.analyst_account_flags AS
      SELECT a.id AS account_id,
             (g.k IS NULL OR NOT ${GSTIN_MATCHABLE("g.k")}) AS gstin_missing,
             NOT (EXISTS (SELECT 1 FROM public.users v WHERE v.vendor_entity_id = a.id)
                  AND NOT EXISTS (SELECT 1 FROM public.dealer_onboarding_applications d WHERE d.dealer_code = a.id)) AS is_dealer
        FROM public.accounts a
        CROSS JOIN LATERAL (SELECT NULLIF(upper(regexp_replace(COALESCE(a.gstin, ''), '\\s', '', 'g')), '') AS k) g`,
  },
  {
    // ID 192 — the idle rule needs the holder's role (an ASM gets idle_asm, everyone else
    // idle_cc). 27 Oct: the staff member's name and active flag too, so "leads per sales rep"
    // can be answered (staff are employees, not customers). `users` itself stays blocked: no
    // phone, email, auth or token columns. STAFF_COLUMNS below is checked after every run.
    name: "analyst_staff",
    base: "users",
    sample: "name",
    sql: () => `CREATE VIEW public.analyst_staff AS
      SELECT u.id::text AS user_id, u.name, u.role, u.is_active FROM public.users u`,
  },
];

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

const baseTables = new Set(
  (await sql`select table_name from information_schema.tables where table_schema = 'public'`).map((r) => r.table_name),
);
const views = MASKED_VIEWS.filter((v) => baseTables.has(v.base));
// Each view's base-table columns here (analyst_leads lists whatever leads has that is not withheld).
const viewCols = new Map();
for (const r of await sql`select table_name, column_name from information_schema.columns
                           where table_schema = 'public' and table_name in ${sql([...views.map((v) => v.base), ""])}
                           order by table_name, ordinal_position`) {
  if (!viewCols.has(r.table_name)) viewCols.set(r.table_name, []);
  viewCols.get(r.table_name).push(r.column_name);
}
const viewSql = (v) => v.sql(viewCols.get(v.base) ?? []);

// Post-run checks (ID 167, 18 Oct): a sample of what must NOT be readable, and of what must stay
// readable for the metric rules. Pairs not in this database are skipped.
const SAMPLE_WITHHELD = [
  ["dealer_leads", "dealer_name"], ["dealer_leads", "shop_name"], ["dealer_leads", "location"], ["dealer_leads", "area"],
  ["dealer_leads", "memory"], ["dealer_leads", "follow_up_history"], ["dealer_leads", "lost_reason_notes"],
  ["user_reporting_lines", "reason"],
  ["lead_touchpoints", "attachments"], ["lead_touchpoints", "external_agent_name"], ["lead_escalations", "ceo_recommendation"],
  ["lead_flow_events", "actor_label"], ["ai_call_logs", "intent_reason"], ["ai_call_logs", "signals"],
  ["ai_call_logs", "score_breakdown"], ["dialer_campaign_leads", "call_outcome"], ["dialer_campaign_leads", "attempt_history"],
  ["sales_invoices", "file_name"], ["sales_invoices", "storage_key"], ["sales_invoices", "payment_reference"],
  ["expense_submissions", "vendor"], ["expense_submissions", "bill_url"], ["orders", "transaction_id"],
  ["inventory_events", "metadata"], ["deployed_assets", "deployment_location"], ["deployed_assets", "telemetry_data"],
  ["ecofy_lead_activities", "created_by_name"], ["scraper_leads", "name"], ["scraped_dealer_leads", "source_url"],
  ["manual_dealer_sales", "uploaded_by"], ["accounts", "gstin"], ["accounts", "contact_phone"], ["account_closures", "reason"],
];
const SAMPLE_KEPT = [
  ["dealer_leads", "city"], ["dealer_leads", "state"], ["dealer_leads", "current_owner_id"], ["dealer_leads", "last_worked_at"],
  ["dealer_leads", "sales_ready_reason"], ["ai_call_logs", "band"], ["ai_call_logs", "intent_score"],
  ["ai_call_logs", "total_cost_cents"], ["expense_submissions", "amount"], ["expense_submissions", "category"],
  ["expense_submissions", "department"], ["invoice_line_items", "product_id"], ["accounts", "city"],
  ["account_closures", "closed_at"], ["lead_visits", "visit_status"],
  ["dealer_leads", "lost_reason"], ["user_reporting_lines", "manager_id"], ["user_reporting_lines", "effective_to"],
];
const STAFF_COLUMNS = ["user_id", "name", "role", "is_active"];
const present = (pairs, side) => pairs.filter(([t, c]) => plan.get(t)?.[side].includes(c));

// The rules, from the catalogue (where the role's privileges are recorded). Sets exitCode 1 on a miss.
async function catalogChecks() {
  const admin = postgres(url, { max: 1, ssl: "require" });
  const can = async (t, c) =>
    (await admin`select has_column_privilege(${ROLE}, ${"public." + t}, ${c}, 'SELECT') as ok`)[0].ok;
  const leaked = [];
  for (const [t, c] of present(SAMPLE_WITHHELD, "withhold")) if (await can(t, c)) leaked.push(`${t}.${c}`);
  const lost = [];
  for (const [t, c] of present(SAMPLE_KEPT, "grant")) if (!(await can(t, c))) lost.push(`${t}.${c}`);
  const [lb] = await admin`select to_regclass('public.leads') is null
                              or (not has_table_privilege(${ROLE}, 'public.leads', 'SELECT')
                                  and not exists (select 1 from information_schema.column_privileges
                                                   where grantee = ${ROLE} and table_schema = 'public' and table_name = 'leads')) as ok`;
  // No masked view may carry a lead id: analyst_leads has no id, the loan views no lead_id.
  const leadIds = await admin`select table_name, column_name from information_schema.columns
                                where table_schema = 'public'
                                  and ((table_name = 'analyst_leads' and column_name in ('id', 'lead_id'))
                                       or (table_name in ('analyst_loan_files', 'analyst_loan_applications') and column_name = 'lead_id'))`;
  const [u] = await admin`select has_table_privilege(${ROLE}, 'public.users', 'SELECT') as ok`;
  // analyst_staff may carry exactly these columns of `users`, nothing more (27 Oct).
  const staffExtra = (await admin`select column_name from information_schema.columns
                                    where table_schema = 'public' and table_name = 'analyst_staff'`)
    .map((r) => r.column_name)
    .filter((c) => !STAFF_COLUMNS.includes(c));
  const [e] = await admin`select to_regclass('public.ecofy_leads') is null
                              or not has_table_privilege(${ROLE}, 'public.ecofy_leads', 'SELECT') as ok`;
  const masked = [];
  for (const v of views) {
    const col = v.sample ?? "customer";
    const [r] = await admin.unsafe(`select ${ident(col)} as s from public.${ident(v.name)} limit 1`);
    const [g] = await admin`select has_table_privilege(${ROLE}, ${"public." + v.name}, 'SELECT') as ok`;
    masked.push(`${v.name}: granted=${g.ok} sample=${r?.s ?? "(no rows)"}`);
  }
  await admin.end();
  const result = {
    users_blocked: !u.ok,
    leads_base_table_blocked: lb.ok,
    ecofy_base_table_blocked: e.ok,
    sample_withheld_checked: present(SAMPLE_WITHHELD, "withhold").length,
    sample_withheld_still_readable: leaked,
    sample_kept_checked: present(SAMPLE_KEPT, "grant").length,
    sample_kept_not_readable: lost,
    masked_view_lead_id_columns: leadIds.map((r) => `${r.table_name}.${r.column_name}`),
    staff_view_extra_columns: staffExtra,
    masked_views: masked,
  };
  result.all_rules_hold =
    result.users_blocked && result.leads_base_table_blocked && result.ecofy_base_table_blocked &&
    !leaked.length && !lost.length && !leadIds.length && !staffExtra.length;
  if (!result.all_rules_hold) process.exitCode = 1;
  return result;
}

if (dryRun) {
  console.log(exists.length ? `role ${ROLE} exists` : `role ${ROLE} does NOT exist in this database`);
  console.log(`masked views a real run would create and grant: ${views.map((v) => v.name).join(", ") || "none"}`);
  const leadsView = views.find((v) => v.name === "analyst_leads");
  if (leadsView) console.log(`analyst_leads would show: ${viewSql(leadsView).match(/SELECT([\s\S]*)FROM/)[1].replace(/\s+/g, " ").trim()}`);
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
for (const v of views) {
  await sql.unsafe(`DROP VIEW IF EXISTS public.${ident(v.name)}`);
  await sql.unsafe(viewSql(v));
  await sql.unsafe(`GRANT SELECT ON public.${ident(v.name)} TO ${ident(ROLE)}`);
  console.log(`  ${v.name}: masked view over ${v.base} (base table not granted)`);
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
  await admin.end();
  console.log({
    tables_readable_in_full: whole,
    tables_with_any_readable_column: partial,
    withheld_column_blocked: withheldReadable === null ? true : !withheldReadable,
    ...(await catalogChecks()),
  });
  console.log("\npassword unchanged — ANALYST_CRM_READONLY_DSN stays as it is");
  process.exit(); // 1 when catalogChecks() found a rule broken
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
let leadsBlocked = false;
try {
  await ro`select 1 from public.leads limit 1`;
} catch {
  leadsBlocked = true;
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
  leads_select_blocked: leadsBlocked,
  ...(await catalogChecks()),
});
console.log("\nANALYST_CRM_READONLY_DSN=postgresql://analyst_ro:<password>@" + target.host + target.pathname + "?sslmode=require");
