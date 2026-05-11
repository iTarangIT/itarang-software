export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import JSZip from "jszip";

import { db } from "@/lib/db";
import {
  coBorrowerDocuments,
  coBorrowers,
  digilockerTransactions,
  inventory,
  kycDocuments,
  kycVerifications,
  leads,
  loanSanctions,
  otherDocumentRequests,
  productCategories,
  productSelections,
  products,
  users,
} from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { launchBrowser } from "@/lib/pdf/launch-browser";

// BRD V2 §2.6 / §3.3 — admin "Download Customer Profile".
// Streams a ZIP shaped exactly to the BRD spec:
//   customer_profile.pdf                    ← 8-section summary
//   /documents/                             ← customer KYC docs
//   /supporting_docs/                       ← Step-3 additional docs
//   /co_borrower_docs/                      ← co-borrower KYC docs
//   /product/product_selection_summary.pdf
// No DB mutation. Allowed any time after Step 4 submission.

const POST_STEP_4_STATUSES = new Set([
  "pending_final_approval",
  "loan_sanctioned",
  "loan_rejected",
  "sold",
]);

// ---------- helpers ---------------------------------------------------------

function extOf(fileName: string | null | undefined, fallback = "bin"): string {
  if (!fileName) return fallback;
  const m = fileName.match(/\.([a-zA-Z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : fallback;
}

function safeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/_+/g, "_").slice(0, 80);
}

async function fetchAsBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[Download Profile] fetch ${url} -> HTTP ${res.status}`);
      return null;
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength === 0) return null;
    return Buffer.from(ab);
  } catch (err) {
    console.warn(
      `[Download Profile] fetch ${url} failed:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function maskAadhaar(raw: string | null | undefined): string {
  if (!raw) return "—";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return "—";
  return `XXXX-XXXX-${digits.slice(-4)}`;
}

function maskAccount(raw: string | null | undefined): string {
  if (!raw) return "—";
  const trimmed = String(raw).trim();
  if (trimmed.length <= 4) return trimmed;
  return `${"X".repeat(trimmed.length - 4)}${trimmed.slice(-4)}`;
}

function htmlEscape(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const str = String(value);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toISOString().slice(0, 10);
}

function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function fmtMoney(n: string | number | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return "—";
  return `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function daysBetween(from: Date | string | null | undefined): string {
  if (!from) return "—";
  const dt = from instanceof Date ? from : new Date(from);
  if (isNaN(dt.getTime())) return "—";
  const days = Math.floor((Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24));
  return `${days} day${days === 1 ? "" : "s"}`;
}

async function renderPdf(html: string): Promise<Buffer> {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- HTML templates --------------------------------------------------

const PDF_BASE_CSS = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #111; font-size: 11pt; line-height: 1.45; margin: 0; padding: 0; }
  h1 { font-size: 18pt; margin: 0 0 4pt 0; }
  h2 { font-size: 13pt; margin: 18pt 0 6pt 0; padding-bottom: 3pt;
    border-bottom: 2px solid #0047AB; color: #0047AB; }
  h3 { font-size: 11pt; margin: 10pt 0 4pt 0; color: #333; }
  .meta { color: #555; font-size: 9.5pt; margin-bottom: 12pt; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; margin: 4pt 0; }
  th, td { border: 1px solid #d0d0d0; padding: 5pt 7pt; text-align: left;
    vertical-align: top; }
  th { background: #f4f6fa; font-weight: 600; }
  .kv th { width: 38%; }
  .right { text-align: right; }
  .muted { color: #777; font-style: italic; }
  .badge { display: inline-block; padding: 1pt 6pt; border-radius: 3pt;
    font-size: 9pt; background: #eef; color: #225; }
  .footer { margin-top: 18pt; font-size: 8.5pt; color: #777; text-align: center; }
`;

interface CustomerProfileData {
  lead: typeof leads.$inferSelect;
  dealer: { name: string | null; phone: string | null; dealer_id: string | null } | null;
  categoryName: string | null;
  subCategoryName: string | null;
  verifications: (typeof kycVerifications.$inferSelect)[];
  esign: typeof digilockerTransactions.$inferSelect | null;
  consentDoc: typeof kycDocuments.$inferSelect | null;
  supportingDocs: (typeof otherDocumentRequests.$inferSelect)[];
  coBorrowerRows: (typeof coBorrowers.$inferSelect)[];
  selection: typeof productSelections.$inferSelect | null;
  battery: typeof inventory.$inferSelect | null;
  charger: typeof inventory.$inferSelect | null;
  loan: typeof loanSanctions.$inferSelect | null;
  generatedAt: string;
  generatedBy: string;
}

function buildCustomerProfileHtml(d: CustomerProfileData): string {
  const { lead } = d;

  // --- Section 3: KYC Verification Results -------------------------------
  // BRD wants Aadhaar / PAN / Bank / CIBIL / Face / Address / RC / Mobile
  // — render whatever rows we have, masking sensitive values.
  const verRows = d.verifications.map((v) => {
    const apiResp = (v.api_response ?? {}) as Record<string, unknown>;
    let detail = "—";
    const t = (v.verification_type || "").toLowerCase();
    if (t.includes("aadhaar") || t.includes("aadhar")) {
      const num = (apiResp.aadhaar_number || apiResp.aadhaarNumber) as string | undefined;
      detail = maskAadhaar(num ?? null);
    } else if (t.includes("pan")) {
      const pan = (apiResp.pan || apiResp.pan_number) as string | undefined;
      detail = pan ? `${pan.slice(0, 5)}XXXX${pan.slice(-1)}` : "—";
    } else if (t.includes("bank")) {
      const acc = (apiResp.account_number || apiResp.accountNumber) as string | undefined;
      detail = maskAccount(acc ?? null);
    } else if (t.includes("cibil") || t.includes("credit")) {
      const score = apiResp.cibil_score ?? apiResp.score ?? apiResp.credit_score;
      detail = score !== undefined && score !== null ? String(score) : "—";
    } else if (t.includes("face")) {
      const ms = v.match_score ? `${v.match_score}%` : "—";
      detail = `match score: ${ms}`;
    } else if (t.includes("address")) {
      detail = String(apiResp.match_status ?? apiResp.status ?? "—");
    } else if (t.includes("rc") || t.includes("vehicle")) {
      detail = String(apiResp.registration_number ?? apiResp.rc_number ?? "—");
    } else if (t.includes("mobile") || t.includes("intel")) {
      detail = String(apiResp.intelligence ?? apiResp.network_status ?? "—");
    }
    return `
      <tr>
        <td>${htmlEscape(v.verification_type)}</td>
        <td>${htmlEscape(v.status || "pending")}</td>
        <td>${htmlEscape(detail)}</td>
        <td>${htmlEscape(fmtDateTime(v.completed_at ?? v.submitted_at))}</td>
      </tr>`;
  }).join("");

  // --- Section 4: Consent ------------------------------------------------
  let consentType = "—";
  let consentDate: Date | string | null | undefined = null;
  let esignTxn: string | null = null;
  if (lead.esign_completed_at) {
    consentType = "Digital (eSign)";
    consentDate = lead.esign_completed_at;
    esignTxn = lead.esign_transaction_id ?? d.esign?.reference_id ?? null;
  } else if (d.consentDoc) {
    consentType = "Manual (signed upload)";
    consentDate = d.consentDoc.uploaded_at;
  } else if (lead.consent_status) {
    consentType = lead.consent_status;
  }

  // --- Section 5: Supporting Documents -----------------------------------
  const supportingRows = d.supportingDocs.length === 0
    ? `<tr><td colspan="3" class="muted">None</td></tr>`
    : d.supportingDocs.map((od) => `
      <tr>
        <td>${htmlEscape(od.doc_label || od.document_name)}</td>
        <td>${htmlEscape(fmtDateTime(od.uploaded_at))}</td>
        <td>${htmlEscape(od.status || od.upload_status || "pending")}</td>
      </tr>`).join("");

  // --- Section 6: Co-Borrower --------------------------------------------
  const showCoBorrower = lead.has_co_borrower || d.coBorrowerRows.length > 0;
  const coBorrowerSection = !showCoBorrower ? "" : `
    <h2>6. Co-Borrower Details</h2>
    ${d.coBorrowerRows.length === 0 ? '<p class="muted">No co-borrower records found.</p>' :
      d.coBorrowerRows.map((cb) => `
        <table class="kv">
          <tr><th>Full Name</th><td>${htmlEscape(cb.full_name)}</td></tr>
          <tr><th>DOB</th><td>${htmlEscape(fmtDate(cb.dob))}</td></tr>
          <tr><th>Relationship</th><td>${htmlEscape(cb.relationship)}</td></tr>
          <tr><th>PAN</th><td>${htmlEscape(cb.pan_no ? `${cb.pan_no.slice(0, 5)}XXXX${cb.pan_no.slice(-1)}` : "—")}</td></tr>
          <tr><th>Aadhaar</th><td>${htmlEscape(maskAadhaar(cb.aadhaar_no))}</td></tr>
          <tr><th>Phone</th><td>${htmlEscape(cb.phone)}</td></tr>
          <tr><th>KYC Status</th><td>${htmlEscape(cb.kyc_status)}</td></tr>
        </table>`).join("")}
  `;

  // --- Section 7: Product Selection --------------------------------------
  const sel = d.selection;
  const paraLines = (sel?.paraphernalia_lines as Array<Record<string, unknown>> | null) ?? [];
  const paraRowsHtml = paraLines.length === 0
    ? '<tr><td colspan="3" class="muted">None</td></tr>'
    : paraLines.map((p) => `
        <tr>
          <td>${htmlEscape(p.product_name || `${p.asset_type ?? ""} ${p.model_type ?? ""}`)}</td>
          <td class="right">${htmlEscape(p.qty)}</td>
          <td class="right">${htmlEscape(fmtMoney(p.line_net as string | number))}</td>
        </tr>`).join("");
  const productSection = !sel ? '<p class="muted">No product selection submitted.</p>' : `
    <table class="kv">
      <tr><th>Battery Serial</th><td>${htmlEscape(sel.battery_serial)}</td></tr>
      <tr><th>Battery Model</th><td>${htmlEscape(d.battery?.model_type)}</td></tr>
      <tr><th>Battery Inventory Age</th><td>${htmlEscape(daysBetween(d.battery?.oem_invoice_date ?? d.battery?.received_date))}</td></tr>
      <tr><th>Battery SOC</th><td>${htmlEscape(d.battery?.soc_percent !== null && d.battery?.soc_percent !== undefined ? `${d.battery?.soc_percent}%` : "—")}</td></tr>
      <tr><th>Charger Serial</th><td>${htmlEscape(sel.charger_serial)}</td></tr>
      <tr><th>Charger Model</th><td>${htmlEscape(d.charger?.model_type)}</td></tr>
      <tr><th>Category</th><td>${htmlEscape(d.categoryName)}</td></tr>
      <tr><th>Sub-Category</th><td>${htmlEscape(d.subCategoryName)}</td></tr>
      <tr><th>Dealer Margin</th><td>${htmlEscape(fmtMoney(sel.dealer_margin))}</td></tr>
      <tr><th>Final Price</th><td><b>${htmlEscape(fmtMoney(sel.final_price))}</b></td></tr>
      <tr><th>Submitted At</th><td>${htmlEscape(fmtDateTime(sel.submitted_at))}</td></tr>
    </table>
    <h3>Paraphernalia</h3>
    <table>
      <thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Line Net</th></tr></thead>
      <tbody>${paraRowsHtml}</tbody>
    </table>
  `;

  // --- Section 8: Admin Decision Log -------------------------------------
  type LogEntry = { ts: string | Date | null; action: string; by: string };
  const log: LogEntry[] = [];
  for (const v of d.verifications) {
    if (v.admin_action_at) {
      log.push({
        ts: v.admin_action_at,
        action: `${v.verification_type} → ${v.admin_action ?? v.status ?? "decision"}`,
        by: v.admin_action_by ?? "—",
      });
    }
  }
  for (const od of d.supportingDocs) {
    if (od.reviewed_at) {
      log.push({
        ts: od.reviewed_at,
        action: `Supporting doc "${od.doc_label}" → ${od.status ?? "reviewed"}`,
        by: od.reviewed_by ?? "—",
      });
    }
  }
  if (d.loan?.sanctioned_at) {
    log.push({
      ts: d.loan.sanctioned_at,
      action: `Loan ${d.loan.status ?? "decision"}`,
      by: d.loan.sanctioned_by ?? "—",
    });
  }
  log.sort((a, b) => {
    const at = a.ts ? new Date(a.ts).getTime() : 0;
    const bt = b.ts ? new Date(b.ts).getTime() : 0;
    return at - bt;
  });
  const logRows = log.length === 0
    ? `<tr><td colspan="3" class="muted">No admin actions recorded.</td></tr>`
    : log.map((e) => `
        <tr>
          <td>${htmlEscape(fmtDateTime(e.ts))}</td>
          <td>${htmlEscape(e.action)}</td>
          <td>${htmlEscape(e.by)}</td>
        </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Customer Profile — ${htmlEscape(lead.id)}</title>
<style>${PDF_BASE_CSS}</style>
</head>
<body>
  <h1>iTarang — Customer Profile</h1>
  <div class="meta">
    Lead <b>${htmlEscape(lead.id)}</b> · Generated ${htmlEscape(d.generatedAt)} · By ${htmlEscape(d.generatedBy)}
  </div>

  <h2>1. Customer Details</h2>
  <table class="kv">
    <tr><th>Full Name</th><td>${htmlEscape(lead.full_name || lead.owner_name)}</td></tr>
    <tr><th>Father / Husband Name</th><td>${htmlEscape(lead.father_or_husband_name)}</td></tr>
    <tr><th>DOB</th><td>${htmlEscape(fmtDate(lead.dob))}</td></tr>
    <tr><th>Phone</th><td>${htmlEscape(lead.phone || lead.mobile)}</td></tr>
    <tr><th>Email</th><td>${htmlEscape(lead.owner_email)}</td></tr>
    <tr><th>Permanent Address</th><td>${htmlEscape(lead.permanent_address)}</td></tr>
    <tr><th>Current Address</th><td>${htmlEscape(lead.current_address)}</td></tr>
    <tr><th>State / City</th><td>${htmlEscape([lead.state, lead.city].filter(Boolean).join(" / ") || "—")}</td></tr>
  </table>

  <h2>2. Lead Details</h2>
  <table class="kv">
    <tr><th>Lead Reference</th><td>${htmlEscape(lead.reference_id || lead.id)}</td></tr>
    <tr><th>Created</th><td>${htmlEscape(fmtDateTime(lead.created_at))}</td></tr>
    <tr><th>Payment Mode</th><td>${htmlEscape(lead.payment_method)}</td></tr>
    <tr><th>Product Category</th><td>${htmlEscape(d.categoryName)}</td></tr>
    <tr><th>Sub-Category</th><td>${htmlEscape(d.subCategoryName)}</td></tr>
    <tr><th>Dealer Code</th><td>${htmlEscape(lead.dealer_id)}</td></tr>
    <tr><th>Dealer Name</th><td>${htmlEscape(d.dealer?.name)}</td></tr>
    <tr><th>Dealer Phone</th><td>${htmlEscape(d.dealer?.phone)}</td></tr>
    <tr><th>KYC Status</th><td><span class="badge">${htmlEscape(lead.kyc_status)}</span></td></tr>
    <tr><th>Lead Status</th><td><span class="badge">${htmlEscape(lead.lead_status)}</span></td></tr>
  </table>

  <h2>3. KYC Verification Results</h2>
  <table>
    <thead>
      <tr><th>Type</th><th>Status</th><th>Detail</th><th>Completed</th></tr>
    </thead>
    <tbody>
      ${verRows || `<tr><td colspan="4" class="muted">No verifications recorded.</td></tr>`}
    </tbody>
  </table>

  <h2>4. Consent</h2>
  <table class="kv">
    <tr><th>Type</th><td>${htmlEscape(consentType)}</td></tr>
    <tr><th>Date</th><td>${htmlEscape(fmtDateTime(consentDate))}</td></tr>
    <tr><th>eSign Transaction ID</th><td>${htmlEscape(esignTxn)}</td></tr>
  </table>

  <h2>5. Supporting Documents</h2>
  <table>
    <thead>
      <tr><th>Document</th><th>Uploaded</th><th>Status</th></tr>
    </thead>
    <tbody>${supportingRows}</tbody>
  </table>

  ${coBorrowerSection}

  <h2>7. Product Selection</h2>
  ${productSection}

  <h2>8. Admin Decision Log</h2>
  <table>
    <thead><tr><th>When</th><th>Action</th><th>By</th></tr></thead>
    <tbody>${logRows}</tbody>
  </table>

  <div class="footer">Generated by iTarang admin profile export · BRD V2 §2.6 / §3.3</div>
</body></html>`;
}

interface ProductSummaryData {
  lead: typeof leads.$inferSelect;
  dealerName: string | null;
  selection: typeof productSelections.$inferSelect | null;
  battery: typeof inventory.$inferSelect | null;
  charger: typeof inventory.$inferSelect | null;
  loan: typeof loanSanctions.$inferSelect | null;
  generatedAt: string;
}

function buildProductSummaryHtml(d: ProductSummaryData): string {
  const sel = d.selection;
  if (!sel) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>${PDF_BASE_CSS}</style></head>
      <body><h1>Product Selection — ${htmlEscape(d.lead.id)}</h1>
      <p class="muted">No product selection submitted yet.</p></body></html>`;
  }

  const paraLines = (sel.paraphernalia_lines as Array<Record<string, unknown>> | null) ?? [];

  const billRows: string[] = [
    `<tr>
      <td>Battery</td>
      <td class="right">${htmlEscape(fmtMoney(sel.battery_gross))}</td>
      <td class="right">${htmlEscape(sel.battery_gst_percent ? `${sel.battery_gst_percent}%` : "—")}</td>
      <td class="right">${htmlEscape(fmtMoney(sel.battery_gst_amount))}</td>
      <td class="right">1</td>
      <td class="right"><b>${htmlEscape(fmtMoney(sel.battery_net ?? sel.battery_price))}</b></td>
    </tr>`,
    `<tr>
      <td>Charger</td>
      <td class="right">${htmlEscape(fmtMoney(sel.charger_gross))}</td>
      <td class="right">${htmlEscape(sel.charger_gst_percent ? `${sel.charger_gst_percent}%` : "—")}</td>
      <td class="right">${htmlEscape(fmtMoney(sel.charger_gst_amount))}</td>
      <td class="right">1</td>
      <td class="right"><b>${htmlEscape(fmtMoney(sel.charger_net ?? sel.charger_price))}</b></td>
    </tr>`,
  ];
  for (const p of paraLines) {
    billRows.push(`<tr>
      <td>${htmlEscape(p.product_name || `${p.asset_type ?? ""} ${p.model_type ?? ""}`)}</td>
      <td class="right">${htmlEscape(fmtMoney(p.unit_gross as string | number))}</td>
      <td class="right">${htmlEscape(p.gst_percent !== undefined ? `${p.gst_percent}%` : "—")}</td>
      <td class="right">${htmlEscape(fmtMoney(p.gst_amount as string | number))}</td>
      <td class="right">${htmlEscape(p.qty)}</td>
      <td class="right"><b>${htmlEscape(fmtMoney((Number(p.unit_net ?? 0) * Number(p.qty ?? 1)) as number))}</b></td>
    </tr>`);
  }

  const loanSection = !d.loan ? "" : `
    <h2>Loan Sanction</h2>
    <table class="kv">
      <tr><th>Status</th><td><span class="badge">${htmlEscape(d.loan.status)}</span></td></tr>
      <tr><th>Lender</th><td>${htmlEscape(d.loan.loan_approved_by)}</td></tr>
      ${d.loan.status === "rejected"
        ? `<tr><th>Rejection Reason</th><td>${htmlEscape(d.loan.rejection_reason)}</td></tr>`
        : `
          <tr><th>Loan Amount</th><td>${htmlEscape(fmtMoney(d.loan.loan_amount))}</td></tr>
          <tr><th>Down Payment</th><td>${htmlEscape(fmtMoney(d.loan.down_payment))}</td></tr>
          <tr><th>Disbursement</th><td>${htmlEscape(fmtMoney(d.loan.disbursement_amount))}</td></tr>
          <tr><th>EMI</th><td>${htmlEscape(fmtMoney(d.loan.emi))} / month</td></tr>
          <tr><th>Tenure</th><td>${htmlEscape(d.loan.tenure_months)} months</td></tr>
          <tr><th>ROI</th><td>${htmlEscape(d.loan.roi)}%</td></tr>
          <tr><th>File Number</th><td>${htmlEscape(d.loan.loan_file_number)}</td></tr>
        `}
      <tr><th>Sanctioned At</th><td>${htmlEscape(fmtDateTime(d.loan.sanctioned_at))}</td></tr>
    </table>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Product Selection — ${htmlEscape(d.lead.id)}</title>
<style>${PDF_BASE_CSS}</style>
</head>
<body>
  <h1>Product Selection Summary</h1>
  <div class="meta">
    Lead <b>${htmlEscape(d.lead.id)}</b> ·
    Customer ${htmlEscape(d.lead.full_name || d.lead.owner_name)} ·
    Dealer ${htmlEscape(d.dealerName)} ·
    Generated ${htmlEscape(d.generatedAt)}
  </div>

  <h2>Bill Breakdown</h2>
  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th class="right">Gross</th>
        <th class="right">GST %</th>
        <th class="right">GST ₹</th>
        <th class="right">Qty</th>
        <th class="right">Net</th>
      </tr>
    </thead>
    <tbody>${billRows.join("")}</tbody>
    <tfoot>
      <tr>
        <th>Subtotal</th>
        <th class="right">${htmlEscape(fmtMoney(sel.gross_subtotal))}</th>
        <th colspan="2" class="right">GST ${htmlEscape(fmtMoney(sel.gst_subtotal))}</th>
        <th class="right">—</th>
        <th class="right">${htmlEscape(fmtMoney(sel.net_subtotal))}</th>
      </tr>
    </tfoot>
  </table>

  <h2>Pricing</h2>
  <table class="kv">
    <tr><th>Dealer Margin</th><td>${htmlEscape(fmtMoney(sel.dealer_margin))}</td></tr>
    <tr><th>Final Price</th><td><b>${htmlEscape(fmtMoney(sel.final_price))}</b></td></tr>
    <tr><th>Payment Mode</th><td>${htmlEscape(sel.payment_mode)}</td></tr>
    <tr><th>Admin Decision</th><td><span class="badge">${htmlEscape(sel.admin_decision)}</span></td></tr>
    <tr><th>Submitted At</th><td>${htmlEscape(fmtDateTime(sel.submitted_at))}</td></tr>
  </table>

  ${loanSection}

  <div class="footer">Generated by iTarang admin profile export · BRD V2 §2.6</div>
</body></html>`;
}

// ---------- handler ---------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireAdminAppUser();
    if (!admin) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }
    const { id: leadId } = await params;

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    if (!POST_STEP_4_STATUSES.has(lead.kyc_status ?? "")) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `Profile download is available only after Step 4 submission (current status: ${lead.kyc_status}).`,
          },
        },
        { status: 400 },
      );
    }

    const [
      customerKycDocs,
      coBorrowerDocsRows,
      verifications,
      coBorrowerRows,
      supportingDocs,
      selectionRows,
      loanRows,
      esignRows,
    ] = await Promise.all([
      db
        .select()
        .from(kycDocuments)
        .where(
          and(
            eq(kycDocuments.lead_id, leadId),
            // doc_for default = 'customer'; treat anything not explicitly
            // co_borrower as customer (defensive — schema default keeps
            // legacy rows on 'customer').
            eq(kycDocuments.doc_for, "customer"),
          ),
        ),
      db
        .select()
        .from(coBorrowerDocuments)
        .where(eq(coBorrowerDocuments.lead_id, leadId)),
      db.select().from(kycVerifications).where(eq(kycVerifications.lead_id, leadId)),
      db.select().from(coBorrowers).where(eq(coBorrowers.lead_id, leadId)),
      db.select().from(otherDocumentRequests).where(eq(otherDocumentRequests.lead_id, leadId)),
      db
        .select()
        .from(productSelections)
        .where(eq(productSelections.lead_id, leadId))
        .orderBy(desc(productSelections.created_at))
        .limit(1),
      db
        .select()
        .from(loanSanctions)
        .where(eq(loanSanctions.lead_id, leadId))
        .orderBy(desc(loanSanctions.created_at))
        .limit(1),
      db
        .select()
        .from(digilockerTransactions)
        .where(eq(digilockerTransactions.lead_id, leadId))
        .orderBy(desc(digilockerTransactions.created_at))
        .limit(1),
    ]);

    const selection = selectionRows[0] ?? null;
    const loan = loanRows[0] ?? null;
    const esign = esignRows[0] ?? null;

    // Resolve dealer info, category names, inventory rows for the PDFs.
    const dealerLookup = lead.dealer_id
      ? await db
          .select({
            dealer_id: users.dealer_id,
            name: users.name,
            phone: users.phone,
            is_active: users.is_active,
          })
          .from(users)
          .where(and(eq(users.dealer_id, lead.dealer_id), eq(users.role, "dealer")))
      : [];
    const dealerRow =
      dealerLookup.find((u) => u.is_active) ?? dealerLookup[0] ?? null;
    const dealer = dealerRow
      ? { name: dealerRow.name, phone: dealerRow.phone, dealer_id: dealerRow.dealer_id }
      : null;

    let categoryName: string | null = null;
    let subCategoryName: string | null = null;
    if (selection?.category) {
      const [cat] = await db
        .select({ name: productCategories.name })
        .from(productCategories)
        .where(eq(productCategories.id, selection.category))
        .limit(1);
      if (cat) categoryName = cat.name;
    }
    if (selection?.sub_category) {
      const [prod] = await db
        .select({
          name: products.name,
          voltage_v: products.voltage_v,
          capacity_ah: products.capacity_ah,
        })
        .from(products)
        .where(eq(products.id, selection.sub_category))
        .limit(1);
      if (prod) {
        const specs = [
          prod.voltage_v ? `${prod.voltage_v}V` : null,
          prod.capacity_ah ? `${prod.capacity_ah}Ah` : null,
        ]
          .filter(Boolean)
          .join(" / ");
        subCategoryName = specs ? `${prod.name} — ${specs}` : prod.name;
      }
    }

    const battery = selection?.battery_serial
      ? (
          await db
            .select()
            .from(inventory)
            .where(eq(inventory.serial_number, selection.battery_serial))
            .limit(1)
        )[0] ?? null
      : null;
    const charger = selection?.charger_serial
      ? (
          await db
            .select()
            .from(inventory)
            .where(eq(inventory.serial_number, selection.charger_serial))
            .limit(1)
        )[0] ?? null
      : null;

    // BRD §4 wants the consent doc (signed PDF) rendered in section 4 of the
    // profile when manual consent was used; pull the most recent one.
    const consentDoc =
      customerKycDocs
        .filter((d) => (d.doc_type || "").toLowerCase().includes("consent"))
        .sort((a, b) => {
          const at = a.uploaded_at ? new Date(a.uploaded_at).getTime() : 0;
          const bt = b.uploaded_at ? new Date(b.uploaded_at).getTime() : 0;
          return bt - at;
        })[0] ?? null;

    const generatedAt = new Date().toISOString();

    // Render both PDFs (sequential — single browser page would be churned twice).
    const profilePdf = await renderPdf(
      buildCustomerProfileHtml({
        lead,
        dealer,
        categoryName,
        subCategoryName,
        verifications,
        esign,
        consentDoc,
        supportingDocs,
        coBorrowerRows,
        selection,
        battery,
        charger,
        loan,
        generatedAt,
        generatedBy: admin.id,
      }),
    );

    const productPdf = await renderPdf(
      buildProductSummaryHtml({
        lead,
        dealerName: dealer?.name ?? null,
        selection,
        battery,
        charger,
        loan,
        generatedAt,
      }),
    );

    // --- Build ZIP -------------------------------------------------------
    const zip = new JSZip();
    zip.file("customer_profile.pdf", profilePdf);

    // /documents/ — customer KYC files only
    const customerFolder = zip.folder("documents");
    if (customerFolder) {
      for (const doc of customerKycDocs) {
        if (!doc.file_url) continue;
        const buf = await fetchAsBuffer(doc.file_url);
        if (!buf) continue;
        const ext = extOf(doc.file_name, "bin");
        const name = `${safeSlug(doc.doc_type)}.${ext}`;
        customerFolder.file(name, buf);
      }
    }

    // /supporting_docs/ — Step-3 additional docs
    const supportingFolder = zip.folder("supporting_docs");
    if (supportingFolder) {
      let i = 1;
      for (const od of supportingDocs) {
        const url = od.file_url || od.document_url;
        if (!url) continue;
        const buf = await fetchAsBuffer(url);
        if (!buf) continue;
        const baseLabel = od.doc_label || od.document_name || `supporting_${i}`;
        const ext = extOf(od.document_name || od.doc_label, "bin");
        const name = `${String(i).padStart(2, "0")}_${safeSlug(
          baseLabel.replace(/\.[^.]+$/, ""),
        )}.${ext}`;
        supportingFolder.file(name, buf);
        i++;
      }
    }

    // /co_borrower_docs/ — co-borrower KYC files (sub-folder per co-borrower
    // when there are multiple, otherwise flat under /co_borrower_docs/).
    const coBorrowerFolder = zip.folder("co_borrower_docs");
    if (coBorrowerFolder && coBorrowerDocsRows.length > 0) {
      const multiple = coBorrowerRows.length > 1;
      const cbNameById = new Map(
        coBorrowerRows.map((cb) => [cb.id, cb.full_name || cb.id]),
      );
      for (const doc of coBorrowerDocsRows) {
        const url = doc.document_url;
        if (!url) continue;
        const buf = await fetchAsBuffer(url);
        if (!buf) continue;
        const ext = extOf(doc.file_name, "bin");
        const fname = `${safeSlug(doc.document_type)}.${ext}`;
        if (multiple && doc.co_borrower_id) {
          const sub = coBorrowerFolder.folder(
            safeSlug(String(cbNameById.get(doc.co_borrower_id) ?? doc.co_borrower_id)),
          );
          sub?.file(fname, buf);
        } else {
          coBorrowerFolder.file(fname, buf);
        }
      }
    }

    // /product/product_selection_summary.pdf
    const productFolder = zip.folder("product");
    productFolder?.file("product_selection_summary.pdf", productPdf);

    const zipBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="customer_profile_${leadId}.zip"`,
        "Content-Length": String(zipBuffer.byteLength),
      },
    });
  } catch (error) {
    console.error("[Download Profile] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to download profile";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
