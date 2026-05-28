/**
 * Generate `NBFC-Dashboard-Data-Catalog.xlsx` — a multi-sheet workbook covering:
 *   1. Overview           — which databases exist, table counts, purpose
 *   2. RDS Tables         — every table in src/lib/db/schema.ts (165) with column count + category
 *   3. NBFC Columns       — every column of every nbfc_* table (4 cols per row)
 *   4. VPS IoT Schema     — 13 VPS tables with their columns + data types
 *   5. NBFC Module Flow   — per-module read/write table map, both DBs
 *   6. Score Computation  — which tables feed CDS & PCI score calculation
 *
 * Run: node drizzle/_export/generate-nbfc-catalog.js
 * Output: drizzle/_export/NBFC-Dashboard-Data-Catalog.xlsx
 */
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CATALOG_JSON = path.join(__dirname, "schema-catalog.json");
const OUT = path.join(__dirname, "NBFC-Dashboard-Data-Catalog.xlsx");

// ─── Helpers ────────────────────────────────────────────────────────────────

const HEADER_FILL = "FF1E3A8A"; // navy
const HEADER_FONT = { color: { argb: "FFFFFFFF" }, bold: true };
const NBFC_FILL = "FFEEF2FF"; // soft indigo
const VPS_FILL = "FFFFF4E5"; // soft amber

function setHeader(ws, columns) {
  ws.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width ?? 24,
  }));
  const row = ws.getRow(1);
  row.height = 22;
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: "FF1E3A8A" } } };
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

function classifyRdsTable(name) {
  if (name.startsWith("nbfc_")) return "NBFC";
  if (
    [
      "loan_sanctions",
      "loan_applications",
      "loan_files",
      "emi_schedules",
      "borrower_risk_scores",
      "telemetry_ingestion_log",
      "iot_devices",
      "risk_hypotheses",
      "risk_card_runs",
      "dual_approval_requests",
      "auction_lots",
      "auction_bids",
      "auction_auto_bids",
      "auction_settlements",
    ].includes(name)
  )
    return "Shared (used by NBFC)";
  if (name.startsWith("auth_")) return "Auth";
  if (name.includes("dealer") || name.includes("inventory") || name.includes("product"))
    return "CRM core";
  return "CRM other";
}

// ─── Sheet builders ─────────────────────────────────────────────────────────

function sheetDashboardTables(wb) {
  const ws = wb.addWorksheet("2 · NBFC Dashboard Tables");
  setHeader(ws, [
    { header: "#", key: "idx", width: 6 },
    { header: "Table", key: "table", width: 36 },
    { header: "DB", key: "db", width: 10 },
    { header: "Category", key: "category", width: 22 },
    { header: "Used in modules", key: "modules", width: 50 },
    { header: "R/W", key: "rw", width: 8 },
    { header: "What it holds", key: "purpose", width: 60 },
  ]);

  // Every table the NBFC dashboard actually touches — read or written —
  // deduplicated and grouped (RDS NBFC → RDS Shared → VPS).
  const rows = [
    // ─── RDS · NBFC-namespaced tables ────────────────────────────────
    ["nbfc_tenants", "RDS", "NBFC", "Settings, Recovery, Risk, Audit", "R", "Tenant identity — legal name, slug, contact, AUM, active loan count, grievance URL"],
    ["nbfc_users", "RDS", "NBFC", "Settings, Audit", "R/W", "Tenant members (role, notification_prefs). Joined to users for display name."],
    ["nbfc_loans", "RDS", "NBFC", "Portfolio, Leads, Batteries, Recovery", "R", "NBFC tenant book — vehicleno, EMI amount, current DPD, outstanding, active flag"],
    ["nbfc_audit_log", "RDS", "NBFC", "Batteries, Leads, Recovery, Audit", "R/W", "Immutable RBI evidence trail — action_type, user, before/after JSON"],
    ["nbfc_borrower_actions", "RDS", "NBFC", "Portfolio, Batteries, Leads, Recovery, Audit", "R/W", "Mutable action state — payment reminder, field visit, immobilisation, restructure, flag-for-recovery"],
    ["nbfc_immobilisation_actions", "RDS", "NBFC", "Portfolio, Batteries, Recovery, Audit", "R/W", "IoT immobilisation executed records — IMEI, executed_at, borrower_notified_at"],
    ["nbfc_loan_restructures", "RDS", "NBFC", "Batteries (drops score confidence)", "R/W", "Restructure history — prior/new EMI amount, tenure, due dom"],
    ["nbfc_risk_alerts", "RDS", "NBFC", "Portfolio, Risk", "R/W", "Portfolio risk flags (pci_low etc.) — type, severity, payload"],
    ["nbfc_risk_rules", "RDS", "NBFC", "Leads, Batteries, Risk, Settings", "R", "Configurable thresholds — CDS bands (low_mid, mid_high), geo_shift_km, etc."],
    ["nbfc_recovery_pipeline", "RDS", "NBFC", "Portfolio, Recovery", "R/W", "Kanban stage per battery serial — needs_inspection → refurbishable → auction → resold"],
    ["nbfc_battery_evaluations", "RDS", "NBFC", "Recovery", "R", "Per-stage inspection records linked to nbfc_recovery_pipeline"],
    ["nbfc_buyback_requests", "RDS", "NBFC", "Recovery", "R/W", "Customer buyback queue (E-118)"],
    ["nbfc_pii_access_grants", "RDS", "NBFC", "Leads (PII unmask)", "R/W", "Short-lived MFA-gated grant tokens for PII unmask"],
    ["nbfc_lsp_agreements", "RDS", "NBFC", "Onboarding, Audit (borrower notice)", "R", "LSP / lender NBFC e-signed agreements"],
    ["nbfc_lsp_agreement_signers", "RDS", "NBFC", "Onboarding", "R", "Per-signer e-sign status"],
    ["nbfc_compliance_documents", "RDS", "NBFC", "Onboarding, Settings", "R", "RBI / corporate compliance docs"],
    ["nbfc_compliance_text", "RDS", "NBFC", "Onboarding wizard, Audit", "R", "Reusable plain-language compliance copy blocks"],
    ["nbfc_directors", "RDS", "NBFC", "Onboarding", "R", "Director records on a tenant"],
    ["nbfc_director_kyc_verifications", "RDS", "NBFC", "Onboarding", "R", "Director KYC results"],
    ["nbfc_entity_kyc_verifications", "RDS", "NBFC", "Onboarding", "R", "Entity-level KYC (PAN, CIN)"],
    ["nbfc_portal_credentials", "RDS", "NBFC", "Onboarding, Settings", "R", "Tenant portal seed credentials"],
    ["nbfc_status_history", "RDS", "NBFC", "Onboarding admin queue", "R", "Onboarding lifecycle transitions"],
    ["nbfc_cor_expiry_alerts", "RDS", "NBFC", "Settings, Portfolio", "R", "Certificate-of-registration expiry alerts"],
    ["nbfc_correction_rounds", "RDS", "NBFC", "Onboarding", "R", "Round-trip correction cycles"],
    ["nbfc_correction_items", "RDS", "NBFC", "Onboarding", "R", "Field-level correction items in a round"],
    ["nbfc_loan_products", "RDS", "NBFC", "Onboarding, Portfolio", "R", "Loan product configuration per tenant"],
    ["nbfc_ecosystem_metrics_cache", "RDS", "NBFC", "Portfolio", "R", "Pre-aggregated dashboard metrics"],
    ["nbfc_score_runs", "RDS", "NBFC", "(reserved)", "—", "Reserved table — currently empty; explainability reads borrower_risk_scores instead"],
    ["nbfc_score_input_snapshots", "RDS", "NBFC", "(reserved)", "—", "Reserved for future per-run input snapshots"],
    ["nbfc_score_overrides", "RDS", "NBFC", "Batteries (manager override)", "R/W", "Manual CDS/PCI overrides with reason + role"],
    ["nbfc_anomaly_flags", "RDS", "NBFC", "Risk", "R", "Flagged anomalous loans"],
    ["nbfc_risk_rule_thresholds", "RDS", "NBFC", "Settings, Risk", "R/W", "Threshold change history"],
    ["nbfc_risk_rule_change_requests", "RDS", "NBFC", "Settings (admin)", "R/W", "Pending threshold edits"],
    ["nbfc_consent_scopes", "RDS", "NBFC", "Onboarding", "R", "Consent scopes (PII, telemetry)"],
    ["nbfc_consent_withdrawals", "RDS", "NBFC", "Onboarding", "R/W", "Recorded consent withdrawals"],
    ["nbfc_retention_tombstones", "RDS", "NBFC", "Compliance (purge)", "R/W", "Soft-purge markers for PII retention windows"],
    ["nbfc_auction_lot_actions", "RDS", "NBFC", "Recovery", "R/W", "Per-lot action log (publish, cancel, finalise)"],
    ["nbfc_auction_cancel_requests", "RDS", "NBFC", "Recovery", "R/W", "Cancel-lot approval queue"],
    ["nbfc_bulk_immobilisation_batches", "RDS", "NBFC", "Recovery (bulk)", "R/W", "Bulk-immobilisation batch records"],
    ["nbfc_audit_log_exports", "RDS", "NBFC", "Audit (CSV export)", "R/W", "Per-export receipt — purpose, filters, row count"],

    // ─── RDS · Shared tables read by NBFC dashboard ───────────────────
    ["loan_sanctions", "RDS", "Shared", "Portfolio, Leads, Batteries, Audit", "R", "Loan core — amount, status, disbursed_at, closed_at, recovery_flagged_at"],
    ["loan_applications", "RDS", "Shared", "Batteries, Recovery", "R", "Fallback for NBFC-direct seeded loans"],
    ["loan_files", "RDS", "Shared", "Batteries, Recovery", "R", "Borrower name, dealer, lead, disbursed_at"],
    ["emi_schedules", "RDS", "Shared", "Portfolio, Leads, Batteries, CDS, PCI", "R", "Per-EMI ledger — due_date, status, paid_at, days_overdue"],
    ["borrower_risk_scores", "RDS", "Shared", "Portfolio, Leads, Batteries", "R/W", "CDS + PCI scores per loan (written by nightly cron)"],
    ["telemetry_ingestion_log", "RDS", "Shared", "Portfolio, Batteries, CDS", "R", "Last VPS ingestion per tenant — feeds Freshness badge + CDS telemetry term"],
    ["leads", "RDS", "Shared", "Portfolio, Leads, Batteries", "R", "Borrower name, phone, city, dealer (PII-gated for NBFC)"],
    ["dealers", "RDS", "Shared", "Leads, Batteries, Recovery", "R", "Dealer company name"],
    ["product_selections", "RDS", "Shared", "Leads", "R", "Financed product model"],
    ["inventory", "RDS", "Shared", "Batteries", "R", "vehicleno → IMEI + warranty info"],
    ["iot_devices", "RDS", "Shared", "Recovery, Batteries", "R", "Device registry — IMEI, dealer, SOC/SOH metadata"],
    ["risk_hypotheses", "RDS", "Shared", "Risk", "R", "Catalogue of hand-coded risk card definitions"],
    ["risk_card_runs", "RDS", "Shared", "Risk", "R/W", "Latest evaluation per hypothesis (re-run button writes)"],
    ["dual_approval_requests", "RDS", "Shared", "Batteries, Recovery", "R/W", "Two-approver gate for immobilisation + restructuring"],
    ["auction_lots", "RDS", "Shared", "Recovery", "R", "Live auction lots"],
    ["auction_bids", "RDS", "Shared", "Recovery", "R/W", "Bid history"],
    ["auction_auto_bids", "RDS", "Shared", "Recovery", "R/W", "Auto-bid caps per bidder"],
    ["auction_settlements", "RDS", "Shared", "Recovery", "R/W", "Settlement status per lot"],
    ["users", "RDS", "Shared", "Audit, Settings", "R", "User identity — joined for actor name/email display"],
    ["audit_logs", "RDS", "Shared", "Audit (flag-for-recovery)", "W", "Generic CRM mutation log — flag_for_recovery writes here as well"],

    // ─── VPS · IoT telemetry tables ───────────────────────────────────
    ["vehicle_state", "VPS", "IoT current", "Portfolio, Batteries, Recovery, Risk", "R", "Current snapshot per vehicle — SOC, SOH, lat/lon, online, last_gps_at"],
    ["immobilizer_state", "VPS", "IoT current", "Batteries", "R", "Device-confirmed immobiliser state — correlates back to nbfc_immobilisation_actions"],
    ["telemetry_battery", "VPS", "IoT time series", "Batteries (Telemetry tab), Risk", "R", "SOC, SOH, voltage, current, temp, charging — sample over time"],
    ["telemetry_gps", "VPS", "IoT time series", "Risk (geo hypotheses)", "R", "GPS pings — used to derive geofence events when geofence_events is empty"],
    ["telemetry_can", "VPS", "IoT time series", "Batteries, Risk (SOH/fault derivation)", "R", "Raw BMS CAN payload as JSONB — SOC, alarms, protections"],
    ["alerts", "VPS", "IoT events", "Portfolio, Batteries", "R", "Alert log — open alert count on the battery row, fleet summary"],
    ["daily_distance_per_vehicle", "VPS", "IoT aggregate", "Batteries (Usage tab), Risk", "R", "Per vehicle per day — km, kwh, trips"],
    ["battery_health_metrics", "VPS", "IoT aggregate", "Batteries (Why-flagged), Recovery", "R", "Daily SOH, 30-day degradation rate, predicted EOL, cycle count"],
    ["geofence_events", "VPS", "IoT events", "Batteries (drawer), Risk", "R", "enter / exit / violation per home centroid"],
    ["charge_events", "VPS", "IoT sessions", "Batteries (drawer)", "R", "Per charge session — start/end SOC, energy_kwh, duration, charger_kind"],
    ["fault_codes", "VPS", "IoT events", "Batteries (Why-flagged), Risk", "R", "BMS DTCs — code, severity, raised_at, resolved_at"],
    ["distance_rollup", "VPS", "IoT aggregate", "CEO fleet dashboard (not NBFC)", "R", "Avg daily km bucket — referenced by CEO dashboard"],
    ["trips", "VPS", "IoT sessions", "Vehicle drawer (legacy)", "R", "Per-trip energy_kwh, avg_speed_kph"],
  ];

  rows.forEach((r, i) => {
    const row = ws.addRow({
      idx: i + 1,
      table: r[0],
      db: r[1],
      category: r[2],
      modules: r[3],
      rw: r[4],
      purpose: r[5],
    });
    if (r[1] === "VPS") {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: VPS_FILL } };
      });
    } else if (r[2] === "NBFC") {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NBFC_FILL } };
      });
    }
    if (r[4] === "R/W" || r[4] === "W") {
      row.getCell("rw").font = { bold: true, color: { argb: "FFB91C1C" } };
    }
  });
  ws.getColumn("purpose").alignment = { wrapText: true, vertical: "top" };
  ws.getColumn("modules").alignment = { wrapText: true, vertical: "top" };

  // Summary block at the bottom
  ws.addRow({});
  const nbfcCount = rows.filter((r) => r[1] === "RDS" && r[2] === "NBFC").length;
  const sharedCount = rows.filter((r) => r[1] === "RDS" && r[2] === "Shared").length;
  const vpsCount = rows.filter((r) => r[1] === "VPS").length;
  const totalRow = ws.addRow({
    idx: "Σ",
    table: `${rows.length} tables total`,
    db: "",
    category: "",
    modules: `${nbfcCount} NBFC-namespaced · ${sharedCount} shared (RDS) · ${vpsCount} VPS`,
    rw: "",
    purpose: "",
  });
  totalRow.font = { bold: true, color: { argb: "FF1E3A8A" } };
  totalRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };
  });
}

function sheetOverview(wb) {
  const ws = wb.addWorksheet("1 · Overview");
  setHeader(ws, [
    { header: "Database", key: "db", width: 26 },
    { header: "Host / Provider", key: "host", width: 28 },
    { header: "Total tables", key: "count", width: 14 },
    { header: "Engine", key: "engine", width: 14 },
    { header: "Purpose", key: "purpose", width: 70 },
  ]);

  ws.addRow({
    db: "Main app DB (RDS)",
    host: "AWS RDS Postgres",
    count: 165,
    engine: "PostgreSQL",
    purpose:
      "Primary store. All CRM tables, NBFC portal data, loans, EMI ledger, audit log, risk scores. Accessed via Drizzle (src/lib/db/index.ts) using DATABASE_URL.",
  });
  ws.addRow({
    db: "IoT telemetry DB (VPS)",
    host: "Hostinger VPS Postgres :5433 (intellicar)",
    count: 13,
    engine: "PostgreSQL",
    purpose:
      "Live battery telemetry. Vehicle current state, time-series SOC/SOH/GPS/CAN, alerts, daily aggregates, charge events, fault codes. Read via raw SQL (src/lib/db/iot.ts) using IOT_DATABASE_URL.",
  });
  ws.addRow({
    db: "Supabase Auth",
    host: "Supabase",
    count: "—",
    engine: "PostgREST",
    purpose:
      "Session / JWT only. resolveActor() reads the session and joins to nbfc_users on RDS. Not used for app data.",
  });
  ws.addRow({
    db: "Upstash Redis",
    host: "Upstash",
    count: "—",
    engine: "Redis",
    purpose:
      "BullMQ background queue (call worker etc.). Not used by NBFC dashboard.",
  });

  // Style summary
  ws.getColumn("count").alignment = { horizontal: "right" };
  ws.getColumn("purpose").alignment = { wrapText: true, vertical: "top" };
  for (let r = 2; r <= 5; r++) ws.getRow(r).height = 56;

  // Big number callout block at the bottom
  ws.addRow({});
  ws.addRow({ db: "Totals" });
  const totalsRow = ws.getRow(ws.rowCount);
  totalsRow.font = { bold: true, color: { argb: "FF1E3A8A" } };
  ws.addRow({
    db: "All RDS tables",
    count: 165,
    purpose: "Includes auth, CRM, leads, loans, kyc, inventory, NBFC portal.",
  });
  ws.addRow({
    db: "NBFC-prefixed tables",
    count: 40,
    purpose: "Tables exclusive to the NBFC portal (nbfc_*).",
  });
  ws.addRow({
    db: "Shared tables read by NBFC",
    count: 14,
    purpose: "loan_sanctions, emi_schedules, borrower_risk_scores, leads, dealers, iot_devices, etc.",
  });
  ws.addRow({
    db: "VPS IoT tables",
    count: 13,
    purpose: "Live telemetry + aggregates. Doc: docs/nbfc/vps_tables.sql (5 newest).",
  });
}

function sheetRdsTables(wb, catalog) {
  const ws = wb.addWorksheet("3 · All RDS Tables");
  setHeader(ws, [
    { header: "Table", key: "name", width: 42 },
    { header: "Category", key: "category", width: 24 },
    { header: "Columns", key: "cols", width: 12 },
    { header: "Const name (Drizzle)", key: "constName", width: 32 },
    { header: "Schema line", key: "schemaLine", width: 14 },
  ]);

  // Sorted: NBFC first, then Shared, then CRM
  const order = { NBFC: 0, "Shared (used by NBFC)": 1, "CRM core": 2, Auth: 3, "CRM other": 4 };
  const sorted = [...catalog]
    .map((t) => ({ ...t, category: classifyRdsTable(t.tableName) }))
    .sort((a, b) => {
      const oa = order[a.category] ?? 9;
      const ob = order[b.category] ?? 9;
      if (oa !== ob) return oa - ob;
      return a.tableName.localeCompare(b.tableName);
    });

  for (const t of sorted) {
    const row = ws.addRow({
      name: t.tableName,
      category: t.category,
      cols: t.columnCount,
      constName: t.constName,
      schemaLine: t.schemaLineHint ?? "",
    });
    if (t.category === "NBFC") {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NBFC_FILL } };
      });
    }
  }
  ws.getColumn("cols").alignment = { horizontal: "right" };
}

// Tables in this set get full column dumps in the "Columns Detail" sheet.
const SHARED_TABLES_USED_BY_NBFC = [
  "loan_sanctions",
  "loan_applications",
  "loan_files",
  "emi_schedules",
  "borrower_risk_scores",
  "telemetry_ingestion_log",
  "leads",
  "dealers",
  "product_selections",
  "inventory",
  "iot_devices",
  "risk_hypotheses",
  "risk_card_runs",
  "dual_approval_requests",
  "auction_lots",
  "auction_bids",
  "auction_auto_bids",
  "auction_settlements",
  "users",
  "audit_logs",
];

function sheetNbfcColumns(wb, catalog) {
  const ws = wb.addWorksheet("4 · Columns Detail (RDS)");
  setHeader(ws, [
    { header: "Category", key: "category", width: 20 },
    { header: "Table", key: "table", width: 32 },
    { header: "Column", key: "col", width: 30 },
    { header: "Data type", key: "type", width: 16 },
    { header: "Stores", key: "notes", width: 60 },
  ]);

  const nbfcTables = catalog
    .filter((t) => t.tableName.startsWith("nbfc_"))
    .sort((a, b) => a.tableName.localeCompare(b.tableName));
  const sharedTables = SHARED_TABLES_USED_BY_NBFC.map((name) =>
    catalog.find((t) => t.tableName === name),
  ).filter(Boolean);

  const writeGroup = (group, label, fill) => {
    // Group banner row
    const banner = ws.addRow({
      category: label,
      table: "",
      col: "",
      type: "",
      notes: "",
    });
    banner.eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
      c.font = { color: { argb: "FFFFFFFF" }, bold: true };
    });

    for (const t of group) {
      for (const c of t.columns) {
        const row = ws.addRow({
          category: label,
          table: t.tableName,
          col: c.name,
          type: c.type,
          notes: inferColumnNote(t.tableName, c.name, c.type),
        });
        if (fill) {
          row.eachCell((cell) => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
          });
        }
      }
      const sep = ws.addRow({});
      sep.height = 4;
    }
  };

  writeGroup(nbfcTables, "NBFC-namespaced (RDS)", NBFC_FILL);
  writeGroup(sharedTables, "Shared used by NBFC (RDS)", "FFF1F5F9");

  ws.getColumn("notes").alignment = { wrapText: true, vertical: "top" };
}

function inferColumnNote(table, col, type) {
  // Table-specific overrides — most informative
  const exact = {
    "nbfc_tenants.legal_name": "Legal NBFC name (e.g. 'Bajaj Finance Limited')",
    "nbfc_tenants.slug": "URL-safe tenant slug",
    "nbfc_tenants.contact_email": "Primary contact for tenant",
    "nbfc_tenants.display_name": "Display name shown in the UI header",
    "nbfc_tenants.grievance_url": "RBI-mandated grievance redressal URL",
    "nbfc_tenants.helpline_phone": "Helpline number on borrower notices",
    "nbfc_tenants.aum_inr": "Assets-under-management in INR",
    "nbfc_tenants.active_loan_count": "Cached active-loan count for KPIs",
    "nbfc_users.role": "NBFC role — viewer | analyst | manager | risk_head | sales_head | admin",
    "nbfc_users.notification_prefs": "JSON — channel preferences (email/sms/push toggles)",
    "nbfc_loans.vehicleno": "IoT vehicle number (the JOIN key to VPS telemetry)",
    "nbfc_loans.emi_amount": "Scheduled EMI amount (₹)",
    "nbfc_loans.emi_due_date_dom": "Day-of-month EMI is due",
    "nbfc_loans.current_dpd": "Days Past Due — refreshed by EMI worker",
    "nbfc_loans.outstanding_amount": "Outstanding principal+interest (₹)",
    "nbfc_loans.is_active": "Loan still being serviced",
    "nbfc_audit_log.action_type": "payment_reminder | field_visit | immobilisation | flag_for_recovery | …",
    "nbfc_audit_log.action_id": "FK back to the borrower-action / approval row",
    "nbfc_audit_log.before_state": "JSON snapshot before the action",
    "nbfc_audit_log.after_state": "JSON snapshot after the action",
    "nbfc_borrower_actions.action_type": "Action code (same enum as audit log)",
    "nbfc_borrower_actions.status": "pending | pending_dual_approval | approved | auto_approved | rejected | executed",
    "nbfc_borrower_actions.requested_by": "FK → users.id (the NBFC user who raised it)",
    "nbfc_borrower_actions.payload": "JSON — channel, reason, context, etc.",
    "nbfc_immobilisation_actions.imei": "Target battery IMEI",
    "nbfc_immobilisation_actions.iot_command_id": "Reference to the IoT-side dispatched command",
    "nbfc_immobilisation_actions.executed_at": "When IoT confirmed execution",
    "nbfc_immobilisation_actions.borrower_notified_at": "When borrower notice was sent (RBI requirement)",
    "nbfc_loan_restructures.prior_emi_amount": "EMI amount before restructure",
    "nbfc_loan_restructures.new_emi_amount": "EMI amount after restructure",
    "nbfc_loan_restructures.prior_tenure_months": "Tenure before",
    "nbfc_loan_restructures.new_tenure_months": "Tenure after",
    "nbfc_loan_restructures.new_emi_due_dom": "New day-of-month for EMI",
    "nbfc_risk_alerts.type": "Alert code (pci_low, geo_shift, soh_decay, …)",
    "nbfc_risk_alerts.severity": "info | warning | high | critical",
    "nbfc_risk_alerts.payload": "JSON — score, threshold, window, etc.",
    "nbfc_risk_rules.rule_key": "Threshold key (cds_low_mid, geo_shift_km, …)",
    "nbfc_risk_rules.current_value": "Active numeric value of the rule",
    "nbfc_recovery_pipeline.stage": "needs_inspection | refurbishable | scrap | ready_for_auction | resold",
    "nbfc_recovery_pipeline.battery_serial": "Serial used as the pipeline key (or LOAN-<id> fallback)",
    "nbfc_audit_log_exports.purpose": "User-typed purpose declaration",
    "nbfc_audit_log_exports.row_count": "Rows in the exported CSV",
    "nbfc_audit_log_exports.filters": "JSON of the filter set used",
    "nbfc_score_overrides.override_value": "Manual CDS/PCI override value",
    "nbfc_score_overrides.reason": "Justification (20–1000 chars)",
    "loan_sanctions.id": "Primary key (uuid for E-026 loans, legacy strings for old)",
    "loan_sanctions.nbfc_id": "Tenant scope — matches nbfc_loans.tenant_id",
    "loan_sanctions.lead_id": "FK → leads.id",
    "loan_sanctions.status": "draft | sanctioned | disbursed | closed | foreclosed",
    "loan_sanctions.recovery_flagged_at": "Set when Risk Head flags for recovery",
    "loan_sanctions.recovery_reason": "Reason captured at flag time",
    "loan_sanctions.closed_at": "Loan closure timestamp",
    "loan_sanctions.disbursed_at": "When loan was disbursed",
    "emi_schedules.due_date": "Scheduled due date for this EMI",
    "emi_schedules.paid_at": "When the EMI was actually paid (NULL if unpaid)",
    "emi_schedules.status": "scheduled | paid | paid_late | overdue | missed",
    "emi_schedules.days_overdue": "Days past due_date (positive = late)",
    "borrower_risk_scores.cds_score": "Credit Default Score 0–100 (higher = worse)",
    "borrower_risk_scores.pci_score": "Payment Consistency Index 0.000–1.000 (higher = better)",
    "borrower_risk_scores.confidence": "HIGH | MEDIUM | LOW",
    "borrower_risk_scores.loan_sanction_id": "FK → loan_sanctions.id",
    "borrower_risk_scores.tenant_id": "NBFC tenant scope",
    "telemetry_ingestion_log.ingested_at": "When VPS pushed telemetry (drives freshness badge)",
    "telemetry_ingestion_log.battery_serial": "Battery the ingestion was for",
    "leads.full_name": "Borrower full name (PII)",
    "leads.mobile_number": "Borrower phone (PII gated)",
    "leads.city": "Borrower city",
    "leads.dealer_id": "Originating dealer",
    "leads.reference_id": "Human-readable reference (e.g. BAJAJ-LIVE-0017)",
    "dealers.name": "Dealer trade name",
    "dealers.company_name": "Dealer legal company name",
    "iot_devices.imei": "Device IMEI",
    "iot_devices.serial_number": "Device serial",
    "iot_devices.dealer_id": "Owning dealer",
    "risk_card_runs.severity": "info | warn | high",
    "risk_card_runs.finding_summary": "Plain-language LLM/rule finding",
    "risk_card_runs.affected_count": "Count of loans matching the hypothesis",
    "risk_card_runs.total_count": "Total loans evaluated",
    "risk_card_runs.llm_model": "Model identifier (when LLM-driven)",
    "dual_approval_requests.action_type": "battery_immobilisation | loan_restructuring | pii_data_access | …",
    "dual_approval_requests.requested_by": "First-approver user id",
    "dual_approval_requests.approved_by": "Second-approver user id (NULL until approved)",
    "dual_approval_requests.status": "pending | approved | rejected | expired",
    "auction_lots.base_price": "Reserve price",
    "auction_lots.increment_amount": "Min bid increment",
    "auction_lots.ends_at": "Lot close time",
    "auction_bids.bid_amount": "Bid value",
    "auction_bids.bidder_id": "Bidder identity",
    "auction_settlements.final_price": "Final settled price",
    "auction_settlements.status": "pending | settled | delivered | failed",
    "audit_logs.entity_type": "Generic entity tag (nbfc_borrower_action, lead, etc.)",
    "audit_logs.action": "Action name (flag_for_recovery, etc.)",
    "audit_logs.performed_by": "User who triggered the change",
    "users.email": "Login email",
    "users.name": "Display name",
    "users.role": "Top-level CRM role",
  };
  const exactKey = `${table}.${col}`;
  if (exact[exactKey]) return exact[exactKey];

  // Generic by column name
  if (col === "id") return `Primary key (${type ?? "uuid"})`;
  if (col === "tenant_id") return "FK → nbfc_tenants.id (tenant isolation)";
  if (col === "user_id") return "FK → users.id";
  if (col === "loan_sanction_id" || col === "loan_application_id")
    return "FK → loan_sanctions / loan_applications";
  if (col === "borrower_id") return "Borrower / lead reference";
  if (col === "created_at") return "Row created timestamp";
  if (col === "updated_at") return "Row last-updated timestamp";
  if (col === "computed_at") return "When the value was computed";
  if (col === "executed_at") return "When the action executed";
  if (col === "approved_at") return "When the action was approved";
  if (col === "rejected_at") return "When the action was rejected";
  if (col === "deleted_at") return "Soft-delete timestamp";
  if (col === "action_type") return "Action code (ENUM-style varchar)";
  if (col === "status") return "Lifecycle status";
  if (col === "before_state" || col === "after_state" || col === "payload")
    return "JSONB blob";
  if (col === "reason" || col === "note" || col === "notes") return "Free-text justification";
  if (col === "vehicleno") return "IoT vehicle number (joins to VPS)";
  if (col === "imei") return "IoT device IMEI";
  if (col === "battery_serial") return "Battery serial number";
  if (col === "cds_score") return "Credit Default Score 0–100";
  if (col === "pci_score") return "Payment Consistency Index 0.000–1.000";
  if (col === "confidence") return "HIGH | MEDIUM | LOW";
  if (col === "is_active") return "Soft-active flag (boolean)";
  if (col.endsWith("_at") && (type === "timestamp" || type === undefined)) return "Timestamp (timestamptz)";
  if (col.endsWith("_id")) return "Foreign key reference";
  if (col.endsWith("_url")) return "URL string";
  if (col.endsWith("_email")) return "Email address";
  if (col.endsWith("_phone")) return "Phone number";
  if (col.endsWith("_name")) return "Name string";
  if (col === "email") return "Email address";
  if (col === "name") return "Display name";
  if (col === "slug") return "URL-safe identifier";
  return "";
}

function sheetVpsTables(wb) {
  const ws = wb.addWorksheet("5 · VPS IoT Schema");
  setHeader(ws, [
    { header: "Table", key: "table", width: 32 },
    { header: "Column", key: "col", width: 28 },
    { header: "Data type", key: "type", width: 16 },
    { header: "Description", key: "desc", width: 60 },
  ]);

  const vps = [
    {
      table: "vehicle_state",
      category: "Current state snapshot (1 row / vehicle)",
      cols: [
        ["vehicleno", "text PK", "IoT vehicle number"],
        ["last_seen", "timestamptz", "Last packet of any kind"],
        ["last_gps_at", "timestamptz", "Last GPS fix — drives the Freshness pill"],
        ["lat", "numeric", "Current latitude"],
        ["lon", "numeric", "Current longitude"],
        ["speed_kph", "numeric", "Current speed"],
        ["heading", "numeric", "Direction of travel"],
        ["ignition", "boolean", "Ignition on/off"],
        ["gps_fix", "boolean", "GPS lock"],
        ["soc_pct", "numeric", "State of charge %"],
        ["soh_pct", "numeric", "State of health %"],
        ["pack_voltage", "numeric", "Battery pack voltage"],
        ["pack_current", "numeric", "Battery pack current"],
        ["pack_temp_c", "numeric", "Pack temperature °C"],
        ["charging", "boolean", "Currently charging"],
        ["online", "boolean", "Reporting in"],
        ["updated_at", "timestamptz", "Row updated_at"],
      ],
    },
    {
      table: "immobilizer_state",
      category: "Current state (1 row / vehicle)",
      cols: [
        ["vehicleno", "text PK", "IoT vehicle number"],
        ["enabled", "boolean", "Immobiliser engaged?"],
        ["last_toggled_at", "timestamptz", "When last toggled"],
        ["last_reason", "text", "Last reason (free text)"],
        ["last_request_id", "text", "Correlates to nbfc_immobilisation_actions.id on RDS"],
      ],
    },
    {
      table: "telemetry_battery",
      category: "Time series — battery",
      cols: [
        ["time", "timestamptz", "Sample time"],
        ["vehicleno", "text", "IoT vehicle number"],
        ["soc_pct", "numeric", "SOC %"],
        ["soh_pct", "numeric", "SOH %"],
        ["pack_voltage", "numeric", "Voltage"],
        ["pack_current", "numeric", "Current"],
        ["pack_temp_c", "numeric", "Pack temperature"],
        ["charging", "boolean", "Charging flag"],
      ],
    },
    {
      table: "telemetry_gps",
      category: "Time series — GPS",
      cols: [
        ["time", "timestamptz", "Sample time"],
        ["vehicleno", "text", "IoT vehicle number"],
        ["lat", "numeric", "Latitude"],
        ["lon", "numeric", "Longitude"],
        ["speed_kph", "numeric", "Speed"],
        ["heading", "numeric", "Heading"],
        ["ignition", "boolean", "Ignition state"],
      ],
    },
    {
      table: "telemetry_can",
      category: "Time series — raw CAN payloads",
      cols: [
        ["time", "timestamptz", "Sample time"],
        ["vehicleno", "text", "IoT vehicle number"],
        ["payload", "jsonb", "Raw BMS payload (SOC/V/I/temp/alarms/protections)"],
      ],
    },
    {
      table: "alerts",
      category: "Event log",
      cols: [
        ["time", "timestamptz", "Alert raised at"],
        ["vehicleno", "text", "IoT vehicle number"],
        ["alert_type", "text", "Alert code"],
        ["severity", "text", "info | warning | critical"],
        ["message", "text", "Human-readable message"],
        ["resolved_at", "timestamptz", "NULL = open alert"],
      ],
    },
    {
      table: "daily_distance_per_vehicle",
      category: "Daily aggregate",
      cols: [
        ["day", "date", "Calendar day"],
        ["vehicleno", "text", "IoT vehicle number"],
        ["km", "numeric", "Total km driven"],
        ["kwh", "numeric", "Energy consumed"],
        ["trips", "integer", "Number of trips"],
      ],
    },
    {
      table: "battery_health_metrics",
      category: "Daily aggregate (vps_tables.sql)",
      cols: [
        ["vehicleno", "text PK", "IoT vehicle number"],
        ["sample_date", "date PK", "Date sampled"],
        ["soh_pct", "numeric(5,2)", "SOH percent"],
        ["degradation_rate_30d", "numeric(6,3)", "pp / day, signed"],
        ["predicted_eol_date", "date", "Projected date SOH crosses 60%"],
        ["cycles_since_install", "integer", "Charge cycles total"],
      ],
    },
    {
      table: "geofence_events",
      category: "Event log (vps_tables.sql)",
      cols: [
        ["id", "bigserial PK", "Auto id"],
        ["vehicleno", "text", "IoT vehicle number"],
        ["geofence_id", "text", "Geofence reference"],
        ["event_type", "text", "enter | exit | violation"],
        ["event_time", "timestamptz", "When event fired"],
        ["lat", "numeric(9,6)", "Latitude"],
        ["lon", "numeric(9,6)", "Longitude"],
        ["distance_km", "numeric(8,2)", "Distance from home cluster"],
      ],
    },
    {
      table: "charge_events",
      category: "Per-session (vps_tables.sql)",
      cols: [
        ["id", "bigserial PK", "Auto id"],
        ["vehicleno", "text", "IoT vehicle number"],
        ["start_time", "timestamptz", "Session start"],
        ["end_time", "timestamptz", "Session end"],
        ["start_soc_pct", "numeric(5,2)", "SOC at start"],
        ["end_soc_pct", "numeric(5,2)", "SOC at end"],
        ["energy_kwh", "numeric(8,3)", "Energy taken"],
        ["duration_s", "integer", "Duration seconds"],
        ["charger_kind", "text", "ac_slow | dc_fast | unknown"],
      ],
    },
    {
      table: "fault_codes",
      category: "Event log (vps_tables.sql)",
      cols: [
        ["id", "bigserial PK", "Auto id"],
        ["vehicleno", "text", "IoT vehicle number"],
        ["dtc_code", "text", "Diagnostic Trouble Code"],
        ["description", "text", "Human description"],
        ["severity", "text", "info | warning | critical"],
        ["raised_at", "timestamptz", "Fault raised"],
        ["resolved_at", "timestamptz", "NULL = still open"],
      ],
    },
    {
      table: "distance_rollup",
      category: "Aggregate (legacy iot_stack)",
      cols: [
        ["time", "timestamptz", "Rollup window"],
        ["distance_km", "numeric", "Distance bucket"],
      ],
    },
    {
      table: "trips",
      category: "Per-trip (legacy iot_stack)",
      cols: [
        ["time", "timestamptz", "Trip end time"],
        ["vehicleno", "text", "IoT vehicle number"],
        ["energy_kwh", "numeric", "Energy used"],
        ["avg_speed_kph", "numeric", "Average speed"],
      ],
    },
  ];

  let firstRowOfTable = 2;
  for (const t of vps) {
    for (const [col, type, desc] of t.cols) {
      const row = ws.addRow({ table: t.table, col, type, desc });
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: VPS_FILL } };
      });
    }
    // Section sub-header showing the category
    const sectionRow = ws.addRow({ table: "", col: "↑ Category:", type: t.category, desc: "" });
    sectionRow.getCell("col").font = { italic: true, color: { argb: "FF6B7280" } };
    sectionRow.getCell("type").font = { italic: true, color: { argb: "FF6B7280" } };
    const sep = ws.addRow({});
    sep.height = 4;
    firstRowOfTable = ws.rowCount + 1;
  }
}

function sheetModuleFlow(wb) {
  const ws = wb.addWorksheet("6 · NBFC Module Flow");
  setHeader(ws, [
    { header: "Module", key: "module", width: 24 },
    { header: "Route", key: "route", width: 22 },
    { header: "Operation", key: "op", width: 12 },
    { header: "DB", key: "db", width: 10 },
    { header: "Table", key: "table", width: 32 },
    { header: "What this provides / writes", key: "note", width: 60 },
  ]);

  const rows = [
    // Portfolio Overview
    ["Portfolio Overview", "/nbfc/portfolio", "Read", "RDS", "loan_sanctions", "Active loans, disbursement dates"],
    ["Portfolio Overview", "/nbfc/portfolio", "Read", "RDS", "nbfc_loans", "Tenant book — DPD, outstanding"],
    ["Portfolio Overview", "/nbfc/portfolio", "Read", "RDS", "leads", "Borrower name, city, dealer"],
    ["Portfolio Overview", "/nbfc/portfolio", "Read", "RDS", "emi_schedules", "Delinquency (overdue / missed >30d)"],
    ["Portfolio Overview", "/nbfc/portfolio", "Read", "RDS", "nbfc_risk_alerts", "Portfolio-wide risk flags"],
    ["Portfolio Overview", "/nbfc/portfolio", "Read", "RDS", "nbfc_recovery_pipeline", "Assets in recovery by stage"],
    ["Portfolio Overview", "/nbfc/portfolio", "Read", "RDS", "nbfc_borrower_actions", "Recent action history"],
    ["Portfolio Overview", "/nbfc/portfolio", "Read", "RDS", "nbfc_immobilisation_actions", "Executed immobilisations"],
    ["Portfolio Overview", "/nbfc/portfolio", "Read", "RDS", "borrower_risk_scores", "Latest CDS per loan"],
    ["Portfolio Overview", "/nbfc/portfolio", "Read", "RDS", "telemetry_ingestion_log", "Freshness badge timestamp"],

    // Lead Intelligence
    ["Lead Intelligence", "/nbfc/leads", "Read", "RDS", "nbfc_loans", "Tenant scope, vehicle serial, DPD"],
    ["Lead Intelligence", "/nbfc/leads", "Read", "RDS", "loan_sanctions", "Loan amount, file number, status"],
    ["Lead Intelligence", "/nbfc/leads", "Read", "RDS", "leads", "Reference ID, name, city, dealer"],
    ["Lead Intelligence", "/nbfc/leads", "Read", "RDS", "dealers", "Dealer company name"],
    ["Lead Intelligence", "/nbfc/leads", "Read", "RDS", "product_selections", "Financed product model"],
    ["Lead Intelligence", "/nbfc/leads", "Read", "RDS", "borrower_risk_scores", "CDS score per loan"],
    ["Lead Intelligence", "/nbfc/leads", "Read", "RDS", "emi_schedules", "Next EMI date / overdue days"],
    ["Lead Intelligence", "/nbfc/leads", "Read", "RDS", "nbfc_risk_rules", "CDS band thresholds"],
    ["Lead Intelligence", "/nbfc/leads", "Write", "RDS", "nbfc_borrower_actions", "Send Payment Reminder (drawer button)"],
    ["Lead Intelligence", "/nbfc/leads", "Write", "RDS", "nbfc_audit_log", "Audit row per action"],
    ["Lead Intelligence", "/nbfc/leads", "Read", "RDS", "nbfc_audit_log", "Lead-scoped audit timeline in the drawer (NEW)"],

    // Battery Monitoring (subset — full list separately above)
    ["Battery Monitoring", "/nbfc/batteries", "Read", "RDS", "nbfc_loans + loan_files + loan_applications", "Portfolio core: vehicleno, DPD, outstanding, borrower"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "RDS", "borrower_risk_scores", "CDS + PCI badges per row"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "RDS", "nbfc_risk_rules", "Band thresholds"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "RDS", "inventory + leads + dealers", "vehicleno → IMEI, borrower phone (PII gated), dealer"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "RDS", "emi_schedules", "EMI History tab + explainability"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "RDS", "nbfc_borrower_actions / nbfc_immobilisation_actions / nbfc_audit_log", "Action History tab"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "RDS", "nbfc_loan_restructures", "Lowers score confidence to LOW"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "VPS", "vehicle_state", "Live SOC, SOH, lat/lon, online flag, freshness"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "VPS", "alerts", "Open-alert count per battery"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "VPS", "telemetry_battery", "Telemetry tab — 30d SOC/SOH series"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "VPS", "daily_distance_per_vehicle", "Usage Pattern tab — daily km"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "VPS", "battery_health_metrics", "Charge cycles / SOH degradation / EOL"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "VPS", "fault_codes", "Open BMS faults"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "VPS", "geofence_events", "Geo-shift > 100km violations"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "VPS", "charge_events", "Charge sessions in drawer"],
    ["Battery Monitoring", "/nbfc/batteries", "Read", "VPS", "immobilizer_state", "Device-confirmed immobilised flag"],
    ["Battery Monitoring", "/nbfc/batteries", "Write", "RDS", "nbfc_borrower_actions", "Payment reminder / field visit / immob / flag"],
    ["Battery Monitoring", "/nbfc/batteries", "Write", "RDS", "nbfc_audit_log", "Immutable RBI evidence trail"],
    ["Battery Monitoring", "/nbfc/batteries", "Write", "RDS", "dual_approval_requests", "Immobilisation + restructuring (dual-gate)"],
    ["Battery Monitoring", "/nbfc/batteries", "Write", "RDS", "nbfc_loan_restructures", "Post-approval restructure executed"],

    // Risk Alerts
    ["Risk Alerts", "/nbfc/risk", "Read", "RDS", "risk_hypotheses", "Catalogue of risk card definitions"],
    ["Risk Alerts", "/nbfc/risk", "Read", "RDS", "risk_card_runs", "Latest evaluation per hypothesis"],
    ["Risk Alerts", "/nbfc/risk", "Read", "RDS", "nbfc_risk_rules", "Thresholds used by evaluators"],
    ["Risk Alerts", "/nbfc/risk", "Read", "RDS", "nbfc_tenants", "Tenant legal identity + grievance URL"],
    ["Risk Alerts", "/nbfc/risk", "Read", "VPS", "various (best-effort)", "Some hypotheses query telemetry directly"],
    ["Risk Alerts", "/nbfc/risk", "Write", "RDS", "risk_card_runs", "Re-run button creates new evaluation row"],

    // Recovery & Auction
    ["Recovery & Auction", "/nbfc/recovery", "Read", "RDS", "nbfc_recovery_pipeline", "Stage per battery (kanban columns)"],
    ["Recovery & Auction", "/nbfc/recovery", "Read", "RDS", "nbfc_loans + loan_files", "Loan context per battery serial"],
    ["Recovery & Auction", "/nbfc/recovery", "Read", "RDS", "iot_devices", "IMEI per serial"],
    ["Recovery & Auction", "/nbfc/recovery", "Read", "RDS", "auction_lots", "Live lots, capacity, SOH, prices"],
    ["Recovery & Auction", "/nbfc/recovery", "Read", "RDS", "auction_bids", "Max bid + bidder count per lot"],
    ["Recovery & Auction", "/nbfc/recovery", "Read", "RDS", "auction_auto_bids", "Active auto-bid caps"],
    ["Recovery & Auction", "/nbfc/recovery", "Read", "RDS", "auction_settlements", "Settlement status per lot"],
    ["Recovery & Auction", "/nbfc/recovery", "Read", "RDS", "nbfc_buyback_requests", "Customer buyback queue"],
    ["Recovery & Auction", "/nbfc/recovery", "Read", "RDS", "nbfc_tenants", "Legal identity for borrower notice preview"],
    ["Recovery & Auction", "/nbfc/recovery", "Read", "VPS", "vehicle_state", "Live SOH per asset"],
    ["Recovery & Auction", "/nbfc/recovery", "Write", "RDS", "auction_bids", "Place bid"],
    ["Recovery & Auction", "/nbfc/recovery", "Write", "RDS", "auction_auto_bids", "Set auto-bid cap"],
    ["Recovery & Auction", "/nbfc/recovery", "Write", "RDS", "auction_settlements", "Finalise settlement"],
    ["Recovery & Auction", "/nbfc/recovery", "Write", "RDS", "nbfc_recovery_pipeline", "Stage transitions via kanban"],
    ["Recovery & Auction", "/nbfc/recovery", "Write", "RDS", "dual_approval_requests", "Initiate battery_immobilisation"],
    ["Recovery & Auction", "/nbfc/recovery", "Write", "RDS", "nbfc_audit_log", "Every action audit-logged"],

    // Audit Log (NEW unified feed)
    ["Audit Log", "/nbfc/audit", "Read", "RDS", "nbfc_audit_log", "Immutable evidence trail (primary feed source)"],
    ["Audit Log", "/nbfc/audit", "Read", "RDS", "nbfc_borrower_actions", "Mutable action state — status + requested_by"],
    ["Audit Log", "/nbfc/audit", "Read", "RDS", "nbfc_immobilisation_actions", "IoT execution stamps + borrower notice timestamp"],
    ["Audit Log", "/nbfc/audit", "Read", "RDS", "users + nbfc_users", "Joined for actor name + role display"],
    ["Audit Log", "/nbfc/audit", "Write", "RDS", "nbfc_audit_log", "CSV export logs itself as audit_log_export row"],

    // Settings
    ["Settings", "/nbfc/settings", "Read", "RDS", "nbfc_users + users", "Tenant members, roles, notification prefs"],
    ["Settings", "/nbfc/settings", "Read", "RDS", "nbfc_tenants", "Legal name, contact email, AUM, active loan count"],
    ["Settings", "/nbfc/settings", "Read", "RDS", "nbfc_risk_rules", "Threshold display (edit is admin-side)"],
    ["Settings", "/nbfc/settings", "Write", "RDS", "nbfc_users", "Invite / delete user, update notification_prefs"],
  ];

  for (const r of rows) {
    const row = ws.addRow({
      module: r[0],
      route: r[1],
      op: r[2],
      db: r[3],
      table: r[4],
      note: r[5],
    });
    if (r[3] === "VPS") {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: VPS_FILL } };
      });
    }
    if (r[2] === "Write") {
      row.getCell("op").font = { bold: true, color: { argb: "FFB91C1C" } };
    }
  }
  ws.getColumn("note").alignment = { wrapText: true, vertical: "top" };
}

function sheetScoreFlow(wb) {
  const ws = wb.addWorksheet("7 · CDS & PCI Flow");
  setHeader(ws, [
    { header: "Score", key: "score", width: 10 },
    { header: "Stage", key: "stage", width: 24 },
    { header: "DB", key: "db", width: 8 },
    { header: "Table", key: "table", width: 30 },
    { header: "Columns used", key: "cols", width: 50 },
    { header: "Used for", key: "use", width: 60 },
  ]);
  const rows = [
    ["CDS", "Input — EMI history", "RDS", "emi_schedules", "status, days_overdue, paid_at, due_date", "Last 6 EMIs feed the weighted sum"],
    ["CDS", "Input — Telemetry freshness", "RDS", "telemetry_ingestion_log", "ingested_at (latest per tenant)", "Stale > 12h → adds 0 → 0.5 to risk"],
    ["CDS", "Input — Restructuring flag", "RDS", "nbfc_loan_restructures", "loan_application_id (any row exists)", "Drops confidence to LOW"],
    ["CDS", "Input — Loan scope", "RDS", "loan_sanctions", "status='disbursed', closed_at IS NULL", "Iterates only active loans"],
    ["CDS", "Output", "RDS", "borrower_risk_scores", "cds_score (0–100), confidence, computed_at", "Immutable history row per nightly run"],
    ["CDS", "Trigger", "—", "/api/cron/nbfc/compute-cds", "—", "Nightly cron via vercel.json"],
    ["", "", "", "", "", ""],
    ["PCI", "Input — EMI history", "RDS", "emi_schedules", "status, days_overdue, paid_at, due_date", "Same last-6 window as CDS"],
    ["PCI", "Output", "RDS", "borrower_risk_scores", "pci_score (0.000–1.000), computed_at", "Updates the latest CDS row (does not create its own)"],
    ["PCI", "Side-effect", "RDS", "nbfc_risk_alerts", "type='pci_low', severity='high|critical'", "Auto-fires when PCI < 0.40"],
    ["PCI", "Trigger", "—", "/api/cron/nbfc/compute-pci", "—", "Nightly cron via vercel.json (runs after CDS)"],
    ["", "", "", "", "", ""],
    ["UI", "Display — list table", "RDS", "borrower_risk_scores → /nbfc/batteries", "cds_score, pci_score, confidence", "Score chips in Battery Monitoring + Lead Intelligence"],
    ["UI", "Explainability drawer", "RDS", "borrower_risk_scores + emi_schedules + nbfc_loan_restructures", "Per-EMI contribution, reasons", "/api/nbfc/scores/explainability"],
    ["UI", "Override", "RDS", "nbfc_score_overrides", "loan_sanction_id, override_value, reason, role", "POST /api/nbfc/scores/override (risk_manager only; doesn't mutate the score)"],
  ];
  for (const r of rows) {
    const row = ws.addRow({
      score: r[0],
      stage: r[1],
      db: r[2],
      table: r[3],
      cols: r[4],
      use: r[5],
    });
    if (r[0] === "CDS") {
      row.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF6FF" } }));
    } else if (r[0] === "PCI") {
      row.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0FDF4" } }));
    } else if (r[0] === "UI") {
      row.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAF5FF" } }));
    }
  }
  ws.getColumn("cols").alignment = { wrapText: true };
  ws.getColumn("use").alignment = { wrapText: true };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_JSON, "utf8"));
  const wb = new ExcelJS.Workbook();
  wb.creator = "iTarang NBFC catalog generator";
  wb.created = new Date();

  sheetOverview(wb);
  sheetDashboardTables(wb);
  sheetRdsTables(wb, catalog);
  sheetNbfcColumns(wb, catalog);
  sheetVpsTables(wb);
  sheetModuleFlow(wb);
  sheetScoreFlow(wb);

  await wb.xlsx.writeFile(OUT);
  console.log(`Wrote ${OUT}`);
  const stat = fs.statSync(OUT);
  console.log(`Size: ${(stat.size / 1024).toFixed(1)} KB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
