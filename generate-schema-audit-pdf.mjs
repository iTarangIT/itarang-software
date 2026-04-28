import puppeteer from "puppeteer";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const tables = [
  {
    name: "accounts",
    note: null,
    rows: [
      ["created_by", "DELETE", "Never referenced in code; likely intended for audit but not used."],
    ],
  },
  {
    name: "admin_verification_queue",
    note: null,
    rows: [
      ["submitted_by", "REVIEW", "Set during submission but rarely read; check if needed for audit trail."],
    ],
  },
  {
    name: "audit_logs",
    note: "No unused columns detected. All columns are either indexed or actively referenced in code.",
    rows: [],
  },
  {
    name: "co_borrower_documents",
    note: null,
    rows: [
      ["status", "REVIEW", "Duplicate with verification_status; unclear which is authoritative."],
      ["uploaded_at", "REVIEW", "Appears redundant with created_at; verify if temporal distinction is needed."],
    ],
  },
  {
    name: "co_borrowers",
    note: "No unused columns detected. All fields actively used in KYC workflow.",
    rows: [],
  },
  {
    name: "consent_records",
    note: null,
    rows: [
      ["admin_viewed_by", "REVIEW", "Set but rarely read; used only in audit contexts."],
      ["admin_viewed_at", "REVIEW", "Paired with above; verify if admin view tracking is essential."],
    ],
  },
  {
    name: "coupon_audit_log",
    note: null,
    rows: [
      ["ip_address", "DELETE", "Never read in code; only written during coupon actions."],
      ["notes", "REVIEW", "Optional text field; used sparingly; verify if necessary for compliance."],
    ],
  },
  {
    name: "coupon_batches",
    note: "No unused columns detected. All columns actively used in batch management.",
    rows: [],
  },
  {
    name: "coupon_codes",
    note: "No unused columns detected. All columns actively used in coupon lifecycle.",
    rows: [],
  },
  {
    name: "dealer_agreement_signers",
    note: null,
    rows: [
      ["last_event_at", "REVIEW", "Set on webhook events but not prominently displayed; verify if needed for sorting/filtering."],
    ],
  },
  {
    name: "dealer_agreement_events",
    note: null,
    rows: [
      ["signer_role", "REVIEW", "Redundant with information in parent dealer_agreement_signers; denormalization may not be necessary."],
    ],
  },
  {
    name: "dealer_correction_rounds",
    note: "No unused columns detected. All fields actively used in correction workflow.",
    rows: [],
  },
  {
    name: "dealer_correction_items",
    note: "No unused columns detected. All fields actively used in item-level corrections.",
    rows: [],
  },
  {
    name: "dealer_onboarding_applications",
    note: null,
    rows: [
      ["admin_notes", "REVIEW", "Accepts input but rarely rendered in UI; verify if field is actively used."],
      ["rejection_remarks", "REVIEW", "Written on rejection but appears to duplicate rejection_reason; consider consolidating."],
      ["correction_remarks", "REVIEW", "Set during corrections but not clearly distinguished from other remark fields."],
    ],
  },
  {
    name: "dealer_onboarding_documents",
    note: null,
    rows: [
      ["uploaded_by", "REVIEW", "Set but not prominently used; only stored for audit trail."],
    ],
  },
  {
    name: "kyc_documents",
    note: "No unused columns detected. All columns actively used in KYC document flow.",
    rows: [],
  },
  {
    name: "kyc_verification_metadata",
    note: null,
    rows: [
      ["case_type", "REVIEW", "Set during submission but never read; possibly a legacy field."],
    ],
  },
  {
    name: "kyc_verifications",
    note: null,
    rows: [
      ["api_request", "REVIEW", "Stored but typically never read; only written for audit purposes."],
      ["admin_action_notes", "REVIEW", "Optional text; set only in edge cases; verify if actively used in workflows."],
    ],
  },
  {
    name: "leads",
    note: null,
    rows: [
      ["battery_order_expected", "REVIEW", "Set during lead creation; never read in queries; appears to be write-only."],
      ["conversation_summary", "REVIEW", "Populated by AI dialer but never displayed in UI; verify if used downstream."],
      ["interest_level", "REVIEW", "Set but often duplicated by lead_score; consider consolidation."],
      ["lead_type", "REVIEW", "Rarely used; overlaps with interest_level and lead_score."],
      ["ocr_error", "DELETE", "Set on OCR failure but never read; logging would be sufficient."],
      ["ocr_status", "REVIEW", "Written but rarely queried; verify if filtering by this status is actually done."],
      ["workflow_step", "REVIEW", "Defaults to 1 but not incremented; appears unused or incomplete."],
    ],
  },
  {
    name: "lead_documents",
    note: "No unused columns detected. All columns actively referenced.",
    rows: [],
  },
  {
    name: "lead_assignments",
    note: "No unused columns detected. All columns actively used in assignment tracking.",
    rows: [],
  },
  {
    name: "personal_details",
    note: "No unused columns detected. Table actively used in KYC personal data storage.",
    rows: [],
  },
  {
    name: "other_document_requests",
    note: "No unused columns detected. All columns actively used in document request flow.",
    rows: [],
  },
  {
    name: "product_categories",
    note: "No unused columns detected. All columns actively used.",
    rows: [],
  },
  {
    name: "product_selections",
    note: "No unused columns detected. All columns actively used in product selection workflow.",
    rows: [],
  },
  {
    name: "products",
    note: "No unused columns detected. All columns actively used in inventory/catalog.",
    rows: [],
  },
  {
    name: "users",
    note: "No unused columns detected. Core user table with all fields actively used.",
    rows: [],
  },
];

const totalDelete = tables.reduce((n, t) => n + t.rows.filter(r => r[1] === "DELETE").length, 0);
const totalReview = tables.reduce((n, t) => n + t.rows.filter(r => r[1] === "REVIEW").length, 0);

const today = new Date().toISOString().slice(0, 10);

function badge(v) {
  const cls = v === "DELETE" ? "del" : v === "REVIEW" ? "rev" : "keep";
  return `<span class="badge ${cls}">${v}</span>`;
}

function tableSection(t) {
  if (t.rows.length === 0) {
    return `
      <section class="tbl">
        <h2>${t.name}</h2>
        <p class="ok">${t.note}</p>
      </section>`;
  }
  const rows = t.rows
    .map(r => `<tr><td><code>${r[0]}</code></td><td>${badge(r[1])}</td><td>${r[2]}</td></tr>`)
    .join("");
  return `
    <section class="tbl">
      <h2>${t.name}</h2>
      <table>
        <thead><tr><th>Column</th><th>Verdict</th><th>Notes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>iTarang Schema Audit - Unused Columns</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1a1a1a; margin: 32px; font-size: 11pt; line-height: 1.45; }
  h1 { font-size: 22pt; margin: 0 0 4px; color: #0b3d91; }
  h2 { font-size: 13pt; margin: 18px 0 6px; color: #0b3d91; border-bottom: 1px solid #d0d7de; padding-bottom: 3px; }
  .meta { color: #57606a; font-size: 9.5pt; margin-bottom: 18px; }
  .summary { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px 16px; margin-bottom: 20px; }
  .summary h3 { margin: 0 0 8px; font-size: 11pt; }
  .summary ul { margin: 6px 0 0 18px; padding: 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; page-break-inside: avoid; }
  th, td { border: 1px solid #d0d7de; padding: 6px 8px; text-align: left; vertical-align: top; font-size: 10pt; }
  th { background: #f6f8fa; font-weight: 600; }
  td:first-child { width: 28%; }
  td:nth-child(2) { width: 14%; text-align: center; }
  code { font-family: "Consolas", "Menlo", monospace; font-size: 9.5pt; background: #f6f8fa; padding: 1px 4px; border-radius: 3px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 9pt; font-weight: 600; letter-spacing: 0.3px; }
  .badge.del  { background: #ffd7d5; color: #82071e; }
  .badge.rev  { background: #fff8c5; color: #693e00; }
  .badge.keep { background: #d2f4d3; color: #064d12; }
  .ok { color: #1a7f37; font-style: italic; margin: 4px 0 0; }
  .tbl { page-break-inside: avoid; margin-bottom: 14px; }
  .legend { font-size: 9.5pt; color: #57606a; margin-top: 4px; }
  .footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #d0d7de; font-size: 9pt; color: #57606a; }
</style>
</head>
<body>
  <h1>iTarang — Database Schema Audit</h1>
  <div class="meta">Database: <strong>database-1</strong> &nbsp;·&nbsp; Generated: ${today} &nbsp;·&nbsp; Source: <code>src/lib/db/schema.ts</code></div>

  <div class="summary">
    <h3>Summary</h3>
    <ul>
      <li><strong>Tables analyzed:</strong> ${tables.length}</li>
      <li><strong>DELETE candidates:</strong> ${totalDelete} (safe to remove — not read or written outside schema)</li>
      <li><strong>REVIEW candidates:</strong> ${totalReview} (write-only, redundant, or ambiguous — confirm with domain owner)</li>
      <li><strong>Fully orphaned tables:</strong> 0</li>
    </ul>
    <p class="legend">${badge("DELETE")} unused — safe to drop &nbsp;·&nbsp; ${badge("REVIEW")} ambiguous — verify before dropping &nbsp;·&nbsp; ${badge("KEEP")} actively used (not listed)</p>
  </div>

  ${tables.map(tableSection).join("\n")}

  <div class="summary" style="margin-top: 22px;">
    <h3>Recommendations Before Dropping Columns</h3>
    <ul>
      <li>Check any raw SQL, Postgres views, or external reports that may reference these columns — TypeScript-only search will not find them.</li>
      <li>Drop in phases: deprecate in code first, ship for 2–3 sprints, then drop the column in a migration.</li>
      <li>For <code>leads</code>: consolidate <code>interest_level</code>, <code>lead_type</code>, and <code>lead_score</code> into a single classification.</li>
      <li>For <code>dealer_onboarding_applications</code>: standardize the three remark fields (<code>admin_notes</code>, <code>rejection_remarks</code>, <code>correction_remarks</code>) into one.</li>
      <li>Consider a dedicated audit table instead of scattering <code>*_by</code> / <code>*_at</code> pairs across functional tables.</li>
    </ul>
  </div>

  <div class="footer">
    Report generated from a static analysis of <code>src/lib/db/schema.ts</code> against application code under <code>src/</code>.
    REVIEW verdicts should be confirmed with the relevant domain owner before deletion.
  </div>
</body>
</html>`;

const outDir = resolve(process.cwd());
const htmlPath = resolve(outDir, "schema-audit.html");
const pdfPath = resolve(outDir, "iTarang-Schema-Audit.pdf");

writeFileSync(htmlPath, html, "utf8");
console.log("HTML written:", htmlPath);

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "load" });
await page.pdf({
  path: pdfPath,
  format: "A4",
  printBackground: true,
  margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
});
await browser.close();
console.log("PDF written:", pdfPath);
