/**
 * Generates a single Excel workbook documenting the features shipped over the
 * last 3 months, organised by compartment / sub-header / point-by-point detail.
 *
 * Output: ./Itarang_Work_Report_3_Months_<YYYY-MM-DD>.xlsx
 *
 * Run with: npm run report:work
 *
 * Pure offline generation — no DB, no env vars, no network.
 */

import ExcelJS from "exceljs";
import path from "node:path";

// ============================================================================
// THEME
// ============================================================================

const COLOR = {
  cover: "0F172A",
  navy: "1F3A5F",
  indigo: "3F3F8C",
  teal: "1F6E73",
  deepBlue: "1A4E8A",
  emerald: "1F6E47",
  accentGray: "F3F4F6",
  borderGray: "D1D5DB",
  noteGray: "6B7280",
  white: "FFFFFF",
};

const FONT_TITLE: Partial<ExcelJS.Font> = { name: "Calibri", size: 16, bold: true, color: { argb: "FF" + COLOR.white } };
const FONT_SUBHEADER: Partial<ExcelJS.Font> = { name: "Calibri", size: 12, bold: true, color: { argb: "FF" + COLOR.white } };
const FONT_SECTION: Partial<ExcelJS.Font> = { name: "Calibri", size: 11, bold: true };
const FONT_LABEL: Partial<ExcelJS.Font> = { name: "Calibri", size: 10, bold: true };
const FONT_DETAIL: Partial<ExcelJS.Font> = { name: "Calibri", size: 10 };
const FONT_NOTE: Partial<ExcelJS.Font> = { name: "Calibri", size: 9, italic: true, color: { argb: "FF" + COLOR.noteGray } };
const FONT_MONO: Partial<ExcelJS.Font> = { name: "Consolas", size: 10 };
const FONT_BULLET: Partial<ExcelJS.Font> = { name: "Calibri", size: 10, color: { argb: "FF" + COLOR.noteGray } };

// ============================================================================
// TYPES
// ============================================================================

type DetailRow = {
  bullet?: string;
  label: string;
  detail?: string;
  note?: string;
  mono?: boolean;
};
type Section = { heading: string; rows: DetailRow[] };
type SubHeader = { title: string; sections: Section[] };
type Compartment = {
  tabTitle: string;
  titleText: string;
  color: string;
  subHeaders: SubHeader[];
};

// ============================================================================
// HELPERS
// ============================================================================

function setupSheet(sheet: ExcelJS.Worksheet) {
  sheet.columns = [
    { key: "bullet", width: 4 },
    { key: "label", width: 44 },
    { key: "detail", width: 80 },
    { key: "note", width: 22 },
  ];
}

function drawCompartmentTitle(sheet: ExcelJS.Worksheet, title: string, colorHex: string) {
  sheet.mergeCells("A1:D1");
  const cell = sheet.getCell("A1");
  cell.value = title;
  cell.font = FONT_TITLE;
  cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + colorHex } };
  sheet.getRow(1).height = 34;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function drawSubHeader(sheet: ExcelJS.Worksheet, rowNum: number, label: string, colorHex: string) {
  sheet.mergeCells(`A${rowNum}:D${rowNum}`);
  const cell = sheet.getCell(`A${rowNum}`);
  cell.value = label;
  cell.font = FONT_SUBHEADER;
  cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + colorHex } };
  sheet.getRow(rowNum).height = 26;
}

function drawSectionHeading(sheet: ExcelJS.Worksheet, rowNum: number, label: string) {
  sheet.mergeCells(`A${rowNum}:D${rowNum}`);
  const cell = sheet.getCell(`A${rowNum}`);
  cell.value = label;
  cell.font = FONT_SECTION;
  cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + COLOR.accentGray } };
  cell.border = { top: { style: "thin", color: { argb: "FF" + COLOR.borderGray } } };
  sheet.getRow(rowNum).height = 20;
}

function drawDetailRow(sheet: ExcelJS.Worksheet, rowNum: number, row: DetailRow) {
  const r = sheet.getRow(rowNum);

  r.getCell("A").value = row.bullet ?? "•";
  r.getCell("A").alignment = { vertical: "top", horizontal: "center" };
  r.getCell("A").font = FONT_BULLET;

  r.getCell("B").value = row.label;
  r.getCell("B").alignment = { vertical: "top", horizontal: "left", wrapText: true };
  r.getCell("B").font = row.mono ? FONT_MONO : FONT_LABEL;

  r.getCell("C").value = row.detail ?? "";
  r.getCell("C").alignment = { vertical: "top", horizontal: "left", wrapText: true };
  r.getCell("C").font = row.mono ? FONT_MONO : FONT_DETAIL;

  r.getCell("D").value = row.note ?? "";
  r.getCell("D").alignment = { vertical: "top", horizontal: "left", wrapText: true };
  r.getCell("D").font = FONT_NOTE;
}

function renderCompartment(sheet: ExcelJS.Worksheet, compartment: Compartment) {
  setupSheet(sheet);
  drawCompartmentTitle(sheet, compartment.titleText, compartment.color);

  let row = 3;
  for (const sh of compartment.subHeaders) {
    drawSubHeader(sheet, row, sh.title, compartment.color);
    row += 1;
    for (const sec of sh.sections) {
      drawSectionHeading(sheet, row, sec.heading);
      row += 1;
      for (const detail of sec.rows) {
        drawDetailRow(sheet, row, detail);
        row += 1;
      }
      row += 1; // spacer between sections
    }
    row += 1; // spacer between sub-headers
  }
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ============================================================================
// CONTENT — DEALER ONBOARDING
// ============================================================================

const DEALER_ONBOARDING: Compartment = {
  tabTitle: "Dealer Onboarding",
  titleText: "1.  Dealer Onboarding — 6-Step Wizard",
  color: COLOR.navy,
  subHeaders: [
    {
      title: "Step 1 — Company Information",
      sections: [
        {
          heading: "Form Fields (Business Details)",
          rows: [
            { label: "Company Name", detail: "Text input. Alphanumeric validation — rejects pure numeric input.", note: "Required" },
            { label: "Company Type", detail: "Dropdown: Sole Proprietorship / Partnership Firm / Private Limited Firm. Drives the branching in Step 3 (Ownership Details).", note: "Required" },
            { label: "Company Address", detail: "Full registered address of the business entity.", note: "Required" },
            { label: "GST Number (GSTIN)", detail: "15-character alphanumeric, auto-uppercased.", note: "Format-validated" },
            { label: "Company PAN Number", detail: "10-character PAN, auto-uppercased.", note: "Format-validated" },
            { label: "Business Summary", detail: "Textarea (5 rows) — describes the dealer's operations, products, and market focus.", note: "Required" },
            { label: "GST Certificate (upload)", detail: "PDF / JPG / PNG. Persisted to storage and referenced in Step 6 review.", note: "Required" },
            { label: "Company PAN (upload)", detail: "PDF / JPG / PNG. Persisted to storage and referenced in Step 6 review.", note: "Required" },
          ],
        },
        {
          heading: "Navigation",
          rows: [
            { label: "Next →", detail: "Validates all required fields, advances to Step 2 — Compliance Documents." },
          ],
        },
      ],
    },
    {
      title: "Step 2 — Compliance Documents",
      sections: [
        {
          heading: "Documents Required (all PDF / JPG / PNG unless noted)",
          rows: [
            { label: "Last 3 Years Company ITR", detail: "Income Tax Returns for the past three financial years." },
            { label: "Last 3 Months Bank Statement", detail: "Company current-account statement." },
            { label: "Four (4) Undated Cheques", detail: "Security cheques against finance facility." },
            { label: "Passport-size Photograph", detail: "JPG / PNG only (no PDF).", note: "Image only" },
            { label: "Udyam Registration Certificate", detail: "MSME Udyam registration document." },
          ],
        },
        {
          heading: "Document Checklist & Navigation",
          rows: [
            { label: "Doc badges", detail: "Required-document badges turn green as each file is uploaded. Step blocks proceed until every badge is satisfied." },
            { label: "← Back / Next →", detail: "Back returns to Step 1; Next advances to Step 3 — Ownership Details." },
          ],
        },
      ],
    },
    {
      title: "Step 3 — Ownership Details (branches by Company Type)",
      sections: [
        {
          heading: "Sole Proprietorship — Owner block",
          rows: [
            { label: "Owner Name, Phone (10-digit), Landline (optional), Email", detail: "Primary contact for the proprietor." },
            { label: "Age (2 digits)", detail: "Numeric." },
            { label: "Owner Photo", detail: "JPG / PNG." },
            { label: "Residential Address", detail: "Address Line 1, City, District, State, Pin Code (6-digit)." },
          ],
        },
        {
          heading: "Partnership Firm — repeatable Partner cards",
          rows: [
            { label: "Partnership Deed (upload)", detail: "PDF / JPG / PNG." },
            { label: "Partner card (add / remove)", detail: "Name, Phone, Landline, Email, Age, Photo, full residential address. \"+ Add Partner\" creates additional rows; trash icon removes." },
          ],
        },
        {
          heading: "Private Limited Firm — repeatable Director cards",
          rows: [
            { label: "MoU (upload)", detail: "Memorandum of Understanding — PDF / JPG / PNG." },
            { label: "AoA (upload)", detail: "Articles of Association — PDF / JPG / PNG." },
            { label: "Director card (add / remove)", detail: "Name, Phone, Landline, Email, Age, Photo, full residential address. \"+ Add Director\" creates additional rows." },
          ],
        },
        {
          heading: "Shared Bank Account block (all company types)",
          rows: [
            { label: "Bank Name, Account Number, IFSC (11-char upper)", detail: "Beneficiary account for finance disbursement." },
            { label: "Beneficiary Name, Branch", detail: "Free-text fields." },
            { label: "Account Type", detail: "Dropdown — Current / Savings / OD." },
          ],
        },
      ],
    },
    {
      title: "Step 4 — Finance Enablement",
      sections: [
        {
          heading: "Choice cards",
          rows: [
            { label: "Yes, enable finance", detail: "Routes flow through Step 5 (Dealer Agreement) where Digio e-sign is initiated." },
            { label: "No, continue without finance", detail: "Skips Step 5; captures Sales Manager block inline before advancing to Step 6." },
          ],
        },
        {
          heading: "Sales Manager block (only when Finance is NOT enabled)",
          rows: [
            { label: "Sales Manager Name", detail: "Free text." },
            { label: "Email", detail: "Email-validated." },
            { label: "Contact Number", detail: "10-digit numeric." },
            { label: "Age", detail: "2-digit numeric." },
          ],
        },
      ],
    },
    {
      title: "Step 5 — Dealer Agreement (Finance-enabled only)",
      sections: [
        {
          heading: "Agreement metadata",
          rows: [
            { label: "Date of Signing", detail: "Date picker." },
            { label: "MoU Date", detail: "Date picker." },
          ],
        },
        {
          heading: "Dealer Signatory (auto-populated from Step 3)",
          rows: [
            { label: "Dealer Signatory dropdown", detail: "Options are pulled from the owner / partners / directors captured in Step 3." },
            { label: "Dealer Signing Method", detail: "Dropdown — Aadhaar eSign / Electronic Signature." },
            { label: "Designation, Email, Mobile", detail: "Read-only — auto-filled from Step 3 selection." },
          ],
        },
        {
          heading: "Sales Manager Information",
          rows: [
            { label: "Name, Email, Contact Number, Age", detail: "Sales Manager who owns the dealer relationship." },
          ],
        },
        {
          heading: "iTarang Signatories",
          rows: [
            { label: "iTarang Signatory 1 (mandatory)", detail: "Full Name, Designation, Email, Mobile, Age, Address, Signing Method." },
            { label: "iTarang Signatory 2 (optional)", detail: "Toggled via \"+ Add iTarang Signatory 2\" button; X icon removes." },
          ],
        },
        {
          heading: "Signing workflow (fixed order)",
          rows: [
            { bullet: "1.", label: "Dealer Signatory", detail: "First to sign." },
            { bullet: "2.", label: "iTarang Signatory 1", detail: "Signs after Dealer." },
            { bullet: "3.", label: "iTarang Signatory 2", detail: "Last (only if added)." },
          ],
        },
        {
          heading: "Navigation",
          rows: [
            { label: "← Back / Continue to Review →", detail: "Back returns to Step 4; Continue advances to Step 6 — Review & Submit." },
          ],
        },
      ],
    },
    {
      title: "Step 6 — Review & Submit",
      sections: [
        {
          heading: "Review tiles (read-only with previews)",
          rows: [
            { label: "Company Details", detail: "Name, Type, GST, PAN, Address." },
            { label: "Primary Contact Details", detail: "Derived from ownership block — Name, Phone, Email." },
            { label: "Owner / Partner / Director Details", detail: "Full info per company type, including photos." },
            { label: "Compliance Documents", detail: "Clickable tiles — GST Cert, Company PAN, ITR, Bank Statement, Cheques, Photo, Udyam Cert — open inline preview modals (PDF viewer + image gallery)." },
            { label: "Ownership & Banking", detail: "Bank Name, Account No, IFSC, Beneficiary, Branch, Account Type." },
            { label: "Finance Enablement", detail: "Yes / No badge + contact person (if applicable)." },
            { label: "Sales Manager", detail: "Name, Email, Mobile, Age (captured in Step 4 or Step 5)." },
            { label: "Agreement Summary (Finance only)", detail: "Agreement Name, Provider (Digio), Status badge, Completion Status, Dates, Stamp Status, Request ID, Provider Doc ID." },
            { label: "Signer Details", detail: "Cards for Dealer, iTarang 1, iTarang 2 — Name, Designation, Email, Phone." },
            { label: "Signing Order", detail: "Sequential numbered steps mirroring Step 5." },
            { label: "OEM Financing", detail: "OEM Financing (Y/N), Vehicle Type, Manufacturer, Brand, State Presence." },
          ],
        },
        {
          heading: "Confirmation Checkboxes (all three required before Submit)",
          rows: [
            { bullet: "☐", label: "I confirm all information submitted is correct" },
            { bullet: "☐", label: "I confirm the uploaded documents are valid" },
            { bullet: "☐", label: "I agree to iTarang onboarding and dealer terms" },
          ],
        },
        {
          heading: "Submit flow",
          rows: [
            { label: "Builds document payload", detail: "documentType, bucketName, storagePath, fileName, fileUrl, mimeType, fileSize for every uploaded file." },
            { label: "POST /api/dealer/onboarding/submit", detail: "Body = { company, compliance, ownership, finance, agreement, documents, reviewChecks }.", mono: true },
            { label: "On success", detail: "completeOnboarding() saves dealerId to localStorage → signs out user → redirects to NEXT_PUBLIC_DEALER_LOGIN_URL (fallback https://sandbox.itarang.com)." },
            { label: "On error", detail: "API error message rendered in red alert above the Submit button." },
            { label: "Submit button", detail: "Disabled until all three confirmations are checked; shows \"Submitting…\" state during the request.", note: "Single unified route" },
          ],
        },
      ],
    },
  ],
};

// ============================================================================
// CONTENT — ADMIN DASHBOARD
// ============================================================================

const ADMIN_DASHBOARD: Compartment = {
  tabTitle: "Admin Dashboard",
  titleText: "2.  Admin Dashboard — NBFC, Admin & Inventory Sections",
  color: COLOR.indigo,
  subHeaders: [
    {
      title: "A. NBFC Navbar",
      sections: [
        {
          heading: "Onboard NBFC",
          rows: [
            { label: "→ See tab \"NBFC Onboarding\"", detail: "The full 6-step admin-side onboarding wizard (Master → Documents → LSP Agreement → Approval → Activation) is documented in the dedicated NBFC Onboarding tab to avoid duplication.", note: "Cross-reference" },
          ],
        },
        {
          heading: "NBFC Directory (/admin/nbfc)",
          rows: [
            { label: "Default filter", detail: "Shows only active NBFCs (live partners). Batch-fetches wizard progress, compliance docs, LSP agreements, signer status.", mono: true },
            { label: "Columns", detail: "NBFC ID · Legal Name · Short Name · Status · RBI Reg No · Partnership Date · COR Expiry · Current Step (with resume URL) · LSP Agreement Status · Signer Progress (X of N signed) · Created At." },
            { label: "Row buttons", detail: "View (read-only detail) · Edit (master details in edit mode, if not locked by status) · Resume (drafts → directs to current-step URL)." },
          ],
        },
        {
          heading: "My Submitted Drafts (/admin/nbfc?owner=me)",
          rows: [
            { label: "Scope", detail: "All in-flight drafts owned by the current user across statuses: draft, pending_admin_review, request_correction, approved.", mono: true },
            { label: "Per row", detail: "Step-progress signal + Resume button → routes to the appropriate step URL." },
          ],
        },
      ],
    },
    {
      title: "B. Admin Navbar",
      sections: [
        {
          heading: "Product Review (/admin/product-review)",
          rows: [
            { label: "KPI cards", detail: "Total · Pending · Sanctioned · Rejected." },
            { label: "Status tabs", detail: "Pending (default) · All · Sanctioned · Rejected." },
            { label: "Payment tabs", detail: "Finance · Cash." },
            { label: "Search", detail: "By lead owner name, dealer name." },
            { label: "Row fields", detail: "Lead ID · Owner Name · Dealer Name · KYC Status · Payment Mode · Admin Decision · Status · Battery Serial · Charger Serial · Final Price · Submitted Date." },
          ],
        },
        {
          heading: "Product Review Detail (/admin/product-review/[leadId])",
          rows: [
            { label: "Product Selection (read-only)", detail: "Category, Model, Battery Serial, Charger Serial." },
            { label: "Pricing table", detail: "Battery Gross/GST/Net · Charger Gross/GST/Net · Paraphernalia lines with qty × unit price → line total. Subtotals: Gross, GST, Net. Payment Mode: Finance or Cash." },
            { label: "Loan Sanction form — Part 1 (Approval)", detail: "Loan Amount · Down Payment · File Charge · Subvention (default 0) · Disbursement Amount · EMI · Tenure Months · ROI · Loan Approved By · Loan File Number." },
            { label: "Loan Sanction form — Part 2 (Rejection)", detail: "Rejection Reason textarea." },
            { label: "Loan Sanctioned button", detail: "POST /api/admin/product-reviews/sanction → status = sanctioned; records loan_amount, emi, tenure_months, loan_approved_by, loan_file_number, sanctioned_at.", mono: true },
            { label: "Loan Rejected button", detail: "POST /api/admin/product-reviews/reject → status = rejected; records rejection_reason.", mono: true },
            { label: "Download Lead Profile", detail: "Exports full lead + product selection as PDF." },
            { label: "Back", detail: "Returns to product review queue." },
          ],
        },
        {
          heading: "B-DV-1. Dealer Validation — List Page (/admin/dealer-verification)",
          rows: [
            { label: "Header stats (4)", detail: "Total Applications · Pending Review (submitted / pending_admin_review / pending_sales_head / under_review / agreement_in_progress) · Approved (approved / completed / succeed) · Correction Cases (under_correction / correction_requested)." },
            { label: "Global search", detail: "Case-insensitive ILIKE across dealerName · companyName · gstNumber · status · companyType · salesManagerName · salesManagerEmail." },
            { label: "Date range filter", detail: "From / To (local midnight boundaries). Active-range badge (e.g. \"15 Jan – 30 Jan · 4 results\") + Clear button." },
            { label: "Export button", detail: "GET /api/admin/dealer-verifications/export?dateFrom=&dateTo=&q= → CSV. Disabled if loading or no results.", mono: true },
            { label: "Table columns (7)", detail: "Dealer (name + ID + submitted timestamp) · Company (name + duplicate badge + GST + type) · Sales Manager (name + email + mobile) · Documents (count badge) · Agreement (status badge: Sent for Signing / Partially Signed / Signed / Not Generated) · Status (status badge) · Actions (Review → /admin/dealer-verification/{dealerId})." },
            { label: "Duplicate badges", detail: "Branch (amber) — same GSTIN, different address → approved as additional location · Duplicate (red) — same GSTIN + PAN + address → blocks approval · PAN Mismatch (red) — GSTIN registered under different PAN." },
          ],
        },
        {
          heading: "B-DV-2. Dealer Validation — Detail Page · Company Panel",
          rows: [
            { label: "Page header", detail: "Company name title · 3 status badges (onboardingStatus / reviewStatus / agreementStatus if financeEnabled). 3 info cards: Submitted At · Company Type · Document Status." },
            { label: "Verification checklist (4 items, ✓)", detail: "Company Details (name + GST + PAN + type all present) · Documents Uploaded (≥1) · Bank Details (bank + account + beneficiary + IFSC all present) · Agreement (financeEnabled=false OR agreement.status=completed)." },
            { label: "Section 1 — Edit cluster", detail: "Edit button toggles edit mode. In edit mode: Cancel + Save Changes buttons + \"Editing mode — click Save Changes to persist to the database\" banner." },
            { label: "Company fields (9)", detail: "Company Name · Address · GST Number · PAN Number · CIN Number · Company Type · Primary Contact Name · Primary Contact Phone · Primary Contact Email." },
            { label: "Owner Residential Address (5 — sole prop or if any value)", detail: "Address Line 1 · City · District · State · Pin Code." },
            { label: "Bank Details (6)", detail: "Bank Name · Account Number · Beneficiary Name · IFSC · Branch · Account Type." },
            { label: "Sales Manager (3)", detail: "Name · Email · Mobile." },
            { label: "Partners / Directors roster", detail: "Read-only nested cards per partner/director: Name · Phone · Email · Landline · Age · Address." },
            { label: "Save → endpoint", detail: "PATCH /api/admin/dealer-verifications/{dealerId} with edited fields. Optimistic local update; on Cancel reverts to last-saved DB values.", mono: true },
          ],
        },
        {
          heading: "B-DV-3. Dealer Validation — Detail Page · Documents Panel",
          rows: [
            { label: "Subtitle", detail: "\"Validate uploaded onboarding and compliance records.\"" },
            { label: "Per-document card", detail: "Document name (bold) · Document type (e.g. PAN Card, GST Certificate) · Rejection reason (red, only if rejected) · View Document link (new tab, disabled if no URL)." },
            { label: "Empty state", detail: "\"No uploaded documents available yet.\" if zero docs." },
          ],
        },
        {
          heading: "B-DV-4. Dealer Validation — Detail Page · Actions Panel (Review Action card)",
          rows: [
            { label: "Remarks textarea", detail: "Placeholder \"Write correction notes or rejection reason…\". Min height 160 px. Required for rejection; optional for approval / correction." },
            { label: "Approve & Activate (green)", detail: "Endpoint: POST /api/admin/dealer-verifications/{dealerId}/approve. Status: submitted → approved. See B-DV-9 for full approval workflow.", mono: true },
            { label: "Request Correction (amber)", detail: "Opens RequestCorrectionDialog. Endpoint: POST .../request-correction. See B-DV-7 for full correction-round flow.", mono: true },
            { label: "Reject Application (red)", detail: "Disabled until remarks non-empty. Endpoint: POST .../reject. Status: submitted → rejected. See B-DV-8 for rejection flow.", mono: true },
            { label: "Blocking alert — Submission Gate", detail: "Shown if onboardingStatus ≠ submitted. \"Approval is blocked — the dealer hasn't submitted onboarding yet …\"" },
            { label: "Blocking alert — Finance Gate", detail: "Shown if financeEnabled=true AND agreementStatus ≠ completed. \"Approval is blocked until the finance agreement reaches completed status.\"" },
            { label: "Blocking alert — Branch Dealer (info)", detail: "Shown if duplicateFlag=branch. \"Branch dealer — will link to existing account ({companyName} / {dealerCode}). Shared fields (GSTIN, PAN, bank) will be read-only.\"" },
            { label: "Blocking alert — Duplicate Dealer (blocks)", detail: "Shown if duplicateFlag=duplicate. \"Approval blocked — duplicate dealer. Another dealer with the same GSTIN, PAN, and address already exists.\"" },
            { label: "Blocking alert — PAN Mismatch (blocks)", detail: "Shown if duplicateFlag=pan-mismatch. \"Approval blocked — PAN mismatch. This GSTIN is registered under a different PAN.\"" },
            { label: "Back to Queue", detail: "Returns to /admin/dealer-verification list." },
          ],
        },
        {
          heading: "B-DV-5. Dealer Validation — Detail Page · Agreement Panel (Finance only)",
          rows: [
            { label: "Agreement Language selector", detail: "Dropdown: English / Hindi / Bengali → PATCH /api/admin/dealer-verifications/{dealerId} with { agreementLanguage }. Shows \"Saving…\" then ✓ Saved badge (3s).", mono: true },
            { label: "Download Signed Agreement (green)", detail: "Enabled if status = signed | completed. GET .../download-signed-agreement → opens in new tab.", mono: true },
            { label: "Download Audit Trail (muted)", detail: "Enabled only if completed. GET .../audit-trail → PDF of Digio audit log. Filename audit-trail-{dealerId}.pdf.", mono: true },
            { label: "Initiate Agreement (blue)", detail: "Shown if agreement NOT initiated. POST .../initiate-agreement with AgreementConfig (dealer signer, financier, iTarang 1, iTarang 2, signing order). Calls internal Digio API (POST /api/integrations/digio/create-agreement) → generates doc from template, creates dealerAgreementSigners rows, status = sent_for_signature, timeline event \"agreement_initiated\".", mono: true },
            { label: "Refresh Status (white)", detail: "Shown after initiate. POST .../refresh-agreement polls Digio for current signer status, updates local table + timeline + re-fetches signers.", mono: true },
            { label: "Re-initiate Agreement (amber)", detail: "Shown if canReInitiate=true (Digio marked prior signing expired/failed). Marks prior superseded. Status: expired / failed → sent_for_signature.", mono: true },
            { label: "Retry Download Signed Copy (green)", detail: "Shown if status=signed but PDF not yet retrieved. POST .../retry-agreement → fetches signed PDF from Digio and caches locally.", mono: true },
            { label: "Agreement Tracking table", detail: "One row per signer (dealer / financier / iTarang_1 / iTarang_2). Columns: Signer Name (bold) · Role (uppercase muted) · Email + Phone · Signer Status badge (signed / viewed / sent / failed / expired / pending) · Actions (Open Link to Digio portal if not signed + providerSigningUrl available; Re-initiate Agreement if canReInitiate=true; otherwise \"No action\")." },
            { label: "Activity Timeline (chronological)", detail: "agreement_initiated · signer_sent · signer_viewed · signer_signed · agreement_completed. Each event row: type · signer role · status badge · timestamp." },
            { label: "Failure Reason banner", detail: "Red badge with message (e.g. \"Digio quota exceeded\", \"Invalid signer email\") if applicable." },
          ],
        },
        {
          heading: "B-DV-6. Dealer Validation — Sales Manager card",
          rows: [
            { label: "Sales Manager info", detail: "Name · Email · Mobile · Age (captured in Dealer Onboarding Step 4 or Step 5)." },
          ],
        },
        {
          heading: "B-DV-7. Dealer Validation — Correction Round flow (numbered)",
          rows: [
            { bullet: "1.", label: "Admin clicks Request Correction", detail: "RequestCorrectionDialog modal opens." },
            { bullet: "2.", label: "Admin fills dialog", detail: "Documents to re-upload (checkbox groups: company / compliance / ownership) · Information to update (company / owner / bank / sales manager) · Reviewer remarks (required) → clicks Send correction request." },
            { bullet: "3.", label: "Backend processes", detail: "Marks prior pending/submitted rounds as superseded → increments round number → snapshots prior doc URLs → creates dealerCorrectionRounds row (status=pending) → generates magic-link token (expiry configurable) → emails dealer with secure link.", mono: true },
            { bullet: "4.", label: "Dealer responds", detail: "Opens magic link → form shows prior values + admin remarks → uploads new docs / fixes fields → optional note (\"I've fixed the PAN scan quality\") → submits → dealerCorrectionRounds.status = submitted." },
            { bullet: "5.", label: "Admin reviews via CorrectionResponsePanel", detail: "Side-by-side diff (previous value → submitted value · previous doc URL → new doc URL · admin remarks + dealer note) → clicks Update application → POST .../apply-correction merges into dealerOnboardingApplications, sets round.status=applied + appliedAt=now.", mono: true },
            { bullet: "6.", label: "Approve button unlocks", detail: "Once applied, the Approve & Activate button becomes enabled." },
          ],
        },
        {
          heading: "B-DV-8. Dealer Validation — Rejection flow",
          rows: [
            { bullet: "1.", label: "Admin enters remarks", detail: "Required textarea (non-empty)." },
            { bullet: "2.", label: "Admin clicks Reject Application (red)", detail: "POST /api/admin/dealer-verifications/{dealerId}/reject with remarks.", mono: true },
            { bullet: "3.", label: "Backend updates", detail: "onboarding_status=rejected · review_status=rejected · dealer_account_status=inactive · stores rejection_remarks. Emails dealer + sales manager + iTarang signatories.", mono: true },
            { bullet: "4.", label: "UI locks", detail: "All buttons disabled. Red banner: \"Application Rejected — this onboarding application has been rejected and is now locked.\" Rejection remarks visible." },
            { bullet: "5.", label: "Terminal state", detail: "No recovery — admin cannot re-open rejected applications. Dealer must submit a new onboarding application." },
          ],
        },
        {
          heading: "B-DV-9. Dealer Validation — Approval flow (post-approval)",
          rows: [
            { bullet: "1.", label: "Pre-flight validation", detail: "onboarding_status must = submitted. Finance-enabled dealers must have agreement.status = completed. No duplicate / PAN-mismatch conflicts (branch OK)." },
            { bullet: "2.", label: "GSTIN conflict resolution", detail: "Branch → reuse existing account ID, mark is_branch_dealer=true. Duplicate / mismatch → reject (409). None → generate new dealer code." },
            { bullet: "3.", label: "Dealer code generation", detail: "Format ACC-ITARANG-YYYYMMDD-{6HEX} (e.g. ACC-ITARANG-20260525-A3F7BC).", mono: true },
            { bullet: "4.", label: "PDF pre-flight (finance only)", detail: "Ensure signed agreement PDF available from Digio · ensure audit trail PDF available. If either missing → 409 \"PDFs not ready yet\"." },
            { bullet: "5.", label: "Supabase Auth user", detail: "Generate temp password → create or update Auth user with role=dealer, dealer_code={code}, email confirmed." },
            { bullet: "6.", label: "Database transaction (atomic)", detail: "Update dealerOnboardingApplications → approved + dealer_account_status=active + completion_status=completed + approved_at + dealer_code + is_branch_dealer. Insert/update dealers row keyed by dealer_code (finance_enabled, onboarding_status=active, activated_at). If not branch: insert accounts row (id=dealerCode, gstin, status=active). Insert/update users row with must_change_password=true.", mono: true },
            { bullet: "7.", label: "Email notifications", detail: "Welcome email to dealer (temp credentials, login URL, support contact, signed agreement PDF + audit trail PDF attached for finance). Internal notification to sales manager + iTarang signatories (NOT dealer): company approved, dealer code assigned, approval timestamp." },
            { bullet: "8.", label: "UI after approval", detail: "Page redirects to /admin/dealer-verification (list). Dealer appears in Approved stat card. Both status badges = approved." },
          ],
        },
        {
          heading: "B-DV-10. Dealer Validation — Endpoints summary",
          rows: [
            { label: "GET /admin/dealer-verifications", detail: "Fetch verification queue with filters.", mono: true },
            { label: "GET /admin/dealer-verifications/export", detail: "Export queue as CSV.", mono: true },
            { label: "GET /admin/dealer-verifications/{dealerId}", detail: "Fetch detail (company, docs, agreement, corrections).", mono: true },
            { label: "PATCH /admin/dealer-verifications/{dealerId}", detail: "Edit company details, set agreement language.", mono: true },
            { label: "POST .../approve", detail: "Approve & activate dealer.", mono: true },
            { label: "POST .../reject", detail: "Reject application with remarks.", mono: true },
            { label: "POST .../request-correction", detail: "Request correction round.", mono: true },
            { label: "POST .../apply-correction", detail: "Apply submitted corrections (merge into application).", mono: true },
            { label: "POST .../initiate-agreement", detail: "Generate Digio agreement, send to signers.", mono: true },
            { label: "POST .../refresh-agreement", detail: "Poll Digio, update signer status.", mono: true },
            { label: "POST .../re-initiate-agreement", detail: "Re-send agreement (after expiry / failure).", mono: true },
            { label: "GET .../agreement-tracking", detail: "Fetch signer table + timeline.", mono: true },
            { label: "GET .../download-signed-agreement", detail: "Download Digio signed PDF.", mono: true },
            { label: "GET .../audit-trail", detail: "Download Digio audit log PDF.", mono: true },
            { label: "GET .../duplicate-check", detail: "Check GSTIN conflicts (branch / duplicate / pan-mismatch).", mono: true },
          ],
        },
      ],
    },
    {
      title: "C. Inventory",
      sections: [
        {
          heading: "C-0. Inventory Network — main landing page (/admin/inventory)",
          rows: [
            { label: "Page purpose", detail: "Cross-dealer view of every battery, charger, and paraphernalia unit (BRD §5.0). File: src/app/(dashboard)/admin/inventory/page.tsx." },
            { label: "5 KPI cards", detail: "Total Units (slate) · Available (emerald, status=available) · Reserved (amber, status=reserved) · Sold (blue, status=sold) · Stock Value (indigo, sum of invoice_value for non-sold / non-written_off). All from /api/admin/inventory/all kpis.* aggregates.", mono: true },
            { label: "4 Quick Action cards", detail: "Upload Inventory → /admin/inventory/upload · Inter-Dealer Transfer → /admin/inventory/transfer · Ageing Report → /admin/inventory/ageing-report · Add Single Item → /admin/inventory/add.", mono: true },
            { label: "Ageing alert banner", detail: "Computed client-side from current page rows (status NOT in [sold, written_off]). Shows count aged 91–180 days (over90) and count past 180 days (over180). Link to detailed ageing report." },
            { label: "Filter — Dealer", detail: "Dropdown populated from /api/admin/dealers?limit=500. Filters inventory.dealer_id. Defaults to \"All dealers\".", mono: true },
            { label: "Filter — Status", detail: "Options available · reserved · sold · written_off · transferred_in · transferred_out.", mono: true },
            { label: "Filter — Sub-category", detail: "Options battery · charger · DigitalSOC · VoltSOC · Harness. ORs across inventory.sub_category and inventory.asset_type.", mono: true },
            { label: "Filter — Search", detail: "ILIKE across serial_number / model_type / material_code. Placeholder \"Serial / material / model\".", mono: true },
            { label: "Filter — Rows per page", detail: "Options 10 / 25 / 50 / 100. Defaults 25." },
            { label: "Filter behaviour", detail: "All filters are reactive — changing any resets to page 1 and refetches immediately. No Apply button." },
            { label: "Table column — Serial", detail: "serialNumber, monospace, blue link. Click opens detail modal." },
            { label: "Table column — Model", detail: "modelNumber, left-aligned." },
            { label: "Table column — Type", detail: "Formatted as \"Category / SubCategory\" (e.g. \"Battery / battery\")." },
            { label: "Table column — Dealer", detail: "dealerName (fallback dealer lookup by ID)." },
            { label: "Table column — Warehouse", detail: "warehouseLocation, muted." },
            { label: "Table column — Status badge", detail: "Color-coded: available=emerald · reserved=amber · sold=indigo · written_off=gray · transferred_in=cyan · transferred_out=purple." },
            { label: "Table column — Value", detail: "invoiceValue formatted as ₹ with en-IN locale, right-aligned, tabular numerals." },
            { label: "Table column — Age", detail: "Days since createdAt (e.g. \"45d\"; \"—\" if unknown), right-aligned." },
            { label: "Header button — Download CSV", detail: "GET /api/admin/inventory/all?format=csv with current filters → CSV up to 5000 rows. Filename inventory-YYYY-MM-DD.csv. Disabled if loading / exporting / no rows.", mono: true },
            { label: "Header button — Bulk Upload (blue)", detail: "Routes to /admin/inventory/upload (the 4-step wizard documented below)." },
            { label: "Header button — + Add Item", detail: "Routes to /admin/inventory/add (single-item add form documented below)." },
            { label: "Row click → detail card modal", detail: "Loads /api/inventory/{inventoryId}/card — serial / model · category · IoT / IMEI · material code · SOC · dealer · linked lead · warehouse · age · supplier · invoice · batch ref · OEM warranty dates · warranty record · history timeline (status changes with actor).", mono: true },
            { label: "Pagination", detail: "\"Showing X to Y of Z items\" · Prev / Next (disabled at boundaries) · Page N / M · auto-corrects if user jumps to page > totalPages." },
          ],
        },
        {
          heading: "C-1. Add Single Item — /admin/inventory/add",
          rows: [
            { label: "Form purpose", detail: "Add one inventory unit at a time (for one-off receipts when bulk upload is overkill)." },
            { label: "Asset type tabs", detail: "Battery (serial-tracked) · Charger (serial-tracked) · Paraphernalia (qty-tracked)." },
            { label: "Fields per type", detail: "Mirror the Product Master schema for the selected type — e.g. battery requires Model ID (must reference an active Product Master entry), Serial, IoT Enabled, IMEI (if IoT), Voltage, Capacity, Chemistry (auto-filled from Model ID), Warranty, Invoice details, Dealer assignment." },
            { label: "Invoice copy upload", detail: "PDF / JPG / PNG, persisted alongside the inventory row for audit." },
            { label: "Submit", detail: "POST /api/admin/inventory/single — validates Model ID exists + IoT IMEI rules + dealer assignment, then creates one inventory row in status=available.", mono: true },
          ],
        },
        {
          heading: "C-2. Product Master (/admin/product-master) — Batteries tab",
          rows: [
            { label: "Fields", detail: "Model ID (immutable) · Model Name · Voltage (V) · Capacity (Ah) · Chemistry (LFP / NMC / Lead Acid / Other) · Warranty (months) · IoT Compatibility flag · Compatible Categories (3W / 2W / 4W / Inverter / Solar / Other) · Compatible Sub-categories · Compatible Charger Models (multi-select)." },
            { label: "Endpoints", detail: "GET /api/admin/product-master/batteries?status=active&q= · POST /api/admin/product-master/batteries · PATCH /api/admin/product-master/batteries/{model_id}.", mono: true },
          ],
        },
        {
          heading: "Product Master — Chargers tab",
          rows: [
            { label: "Fields", detail: "Model ID · Model Name · Output Voltage (V) · Output Current (A) · Charging Type (Standard / Fast / Smart / Solar-Compatible) · Base Price (₹) · Warranty (months) · Compatible Battery Models." },
            { label: "Endpoints", detail: "GET / POST / PATCH /api/admin/product-master/chargers (PATCH keyed by model_id; no modelId in body).", mono: true },
          ],
        },
        {
          heading: "Product Master — Paraphernalia tab",
          rows: [
            { label: "Fields", detail: "Item Type Code (lowercase, immutable) · Display Label · Compatible Categories · Max Qty per Lead · Harness Variant flag · Status." },
            { label: "Endpoints", detail: "GET / POST / PATCH /api/admin/product-master/paraphernalia/{item_type_code}.", mono: true },
          ],
        },
        {
          heading: "Product Master — CRUD UI",
          rows: [
            { label: "Add Product", detail: "+ New [Type] opens right-side drawer; status defaults to active; pre-loads compatible battery/charger lists cross-tab." },
            { label: "Edit Product", detail: "Click row → drawer with prefilled data; Model ID / Item Type Code is locked after creation." },
            { label: "Toggle Status", detail: "Mark inactive / Reactivate button inline → PATCH → auto-refreshes both product lists." },
            { label: "Search / Filter", detail: "Real-time by name / code (250 ms debounce); status filter All / Active / Inactive." },
            { label: "Soft delete", detail: "DELETE /api/admin/product-master/[type]/{id} → marks inactive (no hard delete).", mono: true },
          ],
        },
        {
          heading: "Bulk Upload (/admin/inventory/upload) — 4-step wizard",
          rows: [
            { bullet: "1.", label: "Select Dealer", detail: "Searchable dropdown (by name, code, city, state). Shows current stock badge (🔋 batteries, 🔌 chargers, 📦 paraphernalia) + dealer detail card + stock summary." },
            { bullet: "2.", label: "Select Inventory Type", detail: "Three cards — Battery (serial-tracked), Charger (serial-tracked), Paraphernalia (qty-tracked). Selected state persists across steps." },
            { bullet: "3.", label: "Template & File Upload", detail: "Download link → GET /api/admin/inventory/csv-template?type={assetType}. Accepts CSV / XLSX, max 5 MB, drag-drop or browse. Date format YYYY-MM-DD or DD-MM-YYYY accepted. Model ID / Item Type Code anchors the row — voltage/capacity/chemistry/warranty auto-fill from Product Master. IoT Enabled / IMEI allowed only when model is IoT-compatible.", mono: true },
            { bullet: "4.", label: "Preview & Commit", detail: "POST /api/admin/inventory/validate (no DB write) returns { summary: { total, valid, errors }, rows: [...] } with per-row error tags. Summary cards (Total / Valid green / Errors red) + scrollable error table. Commit button disabled when 0 valid → POST /api/admin/inventory/bulk-upload with { dealerId, assetType, rows: validRows[] }. Success modal shows imported count, skipped count, report ID, links to View detailed report / Upload more.", mono: true },
          ],
        },
        {
          heading: "Ageing Report (/admin/inventory/ageing-report)",
          rows: [
            { label: "Filters", detail: "Min Age (days) · Dealer dropdown · Category (Battery / Charger / Paraphernalia)." },
            { label: "KPI buckets (mutually exclusive)", detail: "0–30 days (emerald) · 31–90 days (amber) · 91–180 days (orange) · 181+ days (red)." },
            { label: "Table columns", detail: "Serial Number (mono) · Dealer Name · Category · Model Number · Sold Date (DD-MMM-YYYY) · Age (days, colored by bucket) · Invoice Value (₹) · Status (available / reserved / transferred_out) · SOC % · IoT Enabled (✓ / —)." },
            { label: "Exclusions", detail: "Sold and written_off items filtered out (not shown in counts)." },
            { label: "Endpoints", detail: "GET /api/admin/inventory/ageing-report?minAge=&dealerId=&category= (JSON) and same with &format=csv (download with active filters, date-stamped filename).", mono: true },
          ],
        },
        {
          heading: "Transfer Inventory (/admin/inventory/transfer)",
          rows: [
            { label: "Source Dealer", detail: "Dropdown (required) — loads available inventory for that dealer (status = available only)." },
            { label: "Target Dealer", detail: "Dropdown (required, excludes source dealer)." },
            { label: "Reason", detail: "Textarea — min 5, max 500 chars. Visible in audit trail." },
            { label: "Available Serials grid", detail: "Loads items matching source dealer + available status. Columns: Serial · Category · Asset Type · Model. Checkbox per serial (multi-select). Select all / Clear all buttons. Count display \"Available serials (X) · Y selected\"." },
            { label: "Submit", detail: "POST /api/admin/inventory/transfer { sourceDealerId, targetDealerId, serials, reason }. Returns { transferId, serialCount }. Selected items locked with status = transferred_out until target dealer acknowledges.", mono: true },
            { label: "Recent Transfers panel", detail: "Columns: Transfer ID · Source → Target · # Serials · Date · Status (pending_acknowledgement / acknowledged). Refresh button loads latest." },
            { label: "Status transitions", detail: "available → transferred_out (source) → available (target, after acknowledgement).", mono: true },
          ],
        },
      ],
    },
  ],
};

// ============================================================================
// CONTENT — DEALER DASHBOARD
// ============================================================================

const DEALER_DASHBOARD: Compartment = {
  tabTitle: "Dealer Dashboard",
  titleText: "3.  Dealer Dashboard — Sales & Operations Navbars",
  color: COLOR.teal,
  subHeaders: [
    {
      title: "A. Sales Navbar",
      sections: [
        {
          heading: "A-1. Dashboard Home",
          rows: [
            { label: "Header", detail: "Greeting \"Hello [dealer_name]\" + account status badge. If pending, an approval modal mounts on first load (\"Congratulations\" card with company name, dealer ID, activation date)." },
            { label: "KPI cards (8)", detail: "Total Leads · Converted Leads · Conversion Rate · Commission · Inventory Count · Total Payments · Loan Count · Rewards." },
            { label: "Recent Leads panel", detail: "Last 5–10 hot + qualified leads — columns: Customer · Interest dot (hot / warm / cold) · Status badge · Date. Click routes to KYC (hot+finance) or Product Selection (cash)." },
            { label: "Quick Action cards", detail: "+ New Lead → /dealer-portal/leads/new · View All Leads → /dealer-portal/leads · My Drafts → /dealer-portal/leads/drafts · Inventory → /dealer-portal/inventory." },
            { label: "Approval gate", detail: "If the dealer is not approved, dashboard renders a locked state with \"Contact iTarang support\"." },
          ],
        },
        {
          heading: "A-2. Lead Management — list page (/dealer-portal/leads)",
          rows: [
            { label: "Filters", detail: "Search (name, phone, 500 ms debounce) · Status (All / New / Contacted / Qualified) · Type (All / Hot / Warm / Cold)." },
            { label: "Columns", detail: "Customer (name + phone) · Status badge · Interest (colored dot + label) · Loan Amount (₹) · Created (MM/DD/YYYY) · Actions (View / Edit / Delete on hover)." },
            { label: "View Details (conditional routing)", detail: "Hot + finance → /leads/{id}/kyc · Hot + cash → /leads/{id}/product-selection · Warm/Cold → /leads/new?id={id} (resume Step 1)." },
            { label: "Edit (pencil)", detail: "Modal: Full Name, Phone, Interest Level, Payment Method (cash / dealer_finance / other_finance). PATCH /api/dealer/leads/{id} → auto-refresh.", mono: true },
            { label: "Delete (trash)", detail: "Confirmation modal warns all associated KYC / docs / consent records are permanently removed. DELETE /api/dealer/leads/{id}.", mono: true },
          ],
        },
        {
          heading: "A-3. Lead Creation Wizard — Step 1: Customer & Lead Info (/dealer-portal/leads/new)",
          rows: [
            { label: "Full Name", detail: "Required. Regex /^[A-Za-z\\s.'-]+$/, min 2 chars, letters + spaces only. Auto-capitalised each word." },
            { label: "Father / Husband Name", detail: "Auto-required if payment method is non-cash (Finance path). Letters only, same validation as Full Name." },
            { label: "Date of Birth", detail: "Required. Date picker. Minimum age 18 enforced via calculateAge()." },
            { label: "Phone Number", detail: "Required. Exactly 10 digits, Indian mobile. Regex /^[0-9]{10}$/. onBlur duplicate check → GET /api/leads/check-duplicate?phone=X (duplicates flagged but allowed).", mono: true },
            { label: "Current Address", detail: "Required. Min 20 chars. Full street + city + state + pincode." },
            { label: "Permanent Address", detail: "Min 20 chars if filled. \"Same as current address\" checkbox auto-fills." },
            { label: "Vehicle Reg. Number", detail: "Optional. Auto-uppercased. Populating it makes Vehicle Ownership / Vehicle Owner fields required." },
            { label: "Vehicle Ownership", detail: "Conditional Required (if RC filled). Options Self-Owned / Financed / Leased / etc." },
            { label: "Vehicle Owner Name + Phone", detail: "Conditional Required (if RC filled). 10-digit phone." },
            { label: "Product Category ID", detail: "Required. 3-level cascade: Asset Type → Category → Product. Fetched from /api/dealer/leads/categories + /api/dealer/leads/products.", mono: true },
            { label: "Primary Product ID", detail: "Required. Specific product SKU within the selected category." },
            { label: "Additional Products", detail: "Optional. Multi-row add/remove (chargers + paraphernalia)." },
            { label: "Lead Interest Level", detail: "Required radios — Hot (lead_score=90) · Warm (60) · Cold (30)." },
            { label: "Payment Method", detail: "Required dropdown — Cash · Other Finance · Dealer Finance. Drives Step-1 routing." },
            { label: "Button — Auto-fill from ID", detail: "Opens OCRModal — scan doc photo → pre-fills Full Name · Father/Husband · DOB · Phone · Current Address · Permanent Address." },
            { label: "Button — Digilocker KYC", detail: "Alternative document extraction via DigiLocker (eSign compatible)." },
            { label: "Button — Cancel", detail: "Discards draft if modified; returns to /dealer-portal." },
            { label: "Button — Create Lead", detail: "Opens confirmation modal (Customer name · Phone · Product · Payment method · Next-step preview)." },
            { label: "Submit endpoint", detail: "POST /api/leads/create with { ...formData, leadId, commitStep:true, lead_score, additional_products } → { success:true, data:{ leadId, referenceId } }.", mono: true },
            { label: "Gates (BRD §F.1)", detail: "dealer.onboarding_status = active (always required) · dealer.finance_enabled = true (finance-path only)." },
            { label: "Status transition", detail: "kyc_status=draft → step_1_completed on commit. Row inserted in personalDetails." },
            { label: "Post-Step-1 routing matrix", detail: "Hot + Finance → /dealer-portal/leads/{id}/kyc (Step 2) · Hot + Cash → /dealer-portal/leads/{id}/product-selection (Step 4) · Warm / Cold (any method) → /dealer-portal/leads (returns to list).", mono: true },
          ],
        },
        {
          heading: "A-3. Lead Creation Wizard — Step 2: KYC Verification via Decentro (/dealer-portal/leads/{id}/kyc)",
          rows: [
            { label: "Decentro — Aadhaar (1/3)", detail: "POST /api/kyc/{leadId}/decentro/aadhaar-otp (request OTP) → POST .../aadhaar-verify (submit OTP + Aadhaar). Returns aadhaar_status (verified / rejected / mismatch), masked_aadhaar, pan_from_aadhaar. Stored in kycVerifications (verification_type=aadhaar). Library src/lib/kyc/aadhaarNormalize.ts.", mono: true },
            { label: "Decentro — PAN (2/3)", detail: "POST .../pan-verify with { panNumber, dob }. Returns pan_name, name_match_score, pan_status, father_name, aadhaar_seeding, crossMatchFields. Match rules: name similarity ≥80%, father exact, DOB exact. Library src/lib/kyc/pan-verification.ts.", mono: true },
            { label: "Decentro — Bank (3/3)", detail: "POST .../bank-verify with { accountNumber, ifsc, name, validationType }. Three modes — penniless (name only) · pennydrop (micro-deposit) · hybrid (both). Returns account_holder_name, ifsc_code, bank_name, account_status, verification_id. Library src/lib/kyc/bank-verification.ts.", mono: true },
            { label: "Consent — Digital (Digio eSign)", detail: "POST .../send-consent → SMS / WhatsApp link → customer Aadhaar eSign signs PDF. Auto-poll /api/kyc/{leadId}/consent/sync every 10s while status in [link_sent, link_opened, esign_in_progress]. Lifecycle: link_sent → link_opened → esign_in_progress → esign_completed → admin_review_pending → verified. Max 3 attempts → esign_blocked fallback.", mono: true },
            { label: "Consent — Manual (signed PDF)", detail: "POST .../generate-consent-pdf → dealer prints, customer signs, dealer scans → POST .../upload-signed-consent. Lifecycle: consent_generated → consent_uploaded → admin_review_pending → admin_verified.", mono: true },
            { label: "Document upload", detail: "POST .../upload-document (PNG / JPEG / PDF ≤5 MB). Defined by FINANCE_DOCUMENTS — Aadhaar Copy, PAN Copy, Address Proof, Bank Statement (optional), RC Copy (optional). Each stored in kycDocuments with doc_status (uploaded / verified / rejected). Re-upload via POST .../re-upload.", mono: true },
            { label: "Coupon validation", detail: "POST .../validate-coupon → { valid, coupon_code, status: reserved | used | invalid }.", mono: true },
            { label: "Submit-for-Verification Gate (3 conditions)", detail: "Admin-verified consent · all required docs uploaded · coupon reserved → POST .../submit-verification sets kyc_status=submitted_for_verification.", mono: true },
          ],
        },
        {
          heading: "A-3. Lead Creation — Admin KYC Review (/admin/product-review) — how admin sees & approves",
          rows: [
            { label: "Lead card layout", detail: "Lead summary header · KYC Status badge (Verified / Pending / Rejected / Mismatch) · 4 verification cards arranged horizontally (Aadhaar · PAN · Bank · Address Proof) with status badge + timestamp + reason." },
            { label: "Aadhaar card click", detail: "Modal: masked Aadhaar · matched name · DOB · address (if shared) · PAN seeding status." },
            { label: "PAN card click", detail: "Modal: PAN name · cross-match table (Lead Name vs PAN Name vs Aadhaar Name + similarity score) · father name · email." },
            { label: "Bank card click", detail: "Modal: masked account number · IFSC · bank name · account status · last verified date." },
            { label: "Address card click", detail: "Modal: proof type (Utility bill / Rent receipt / etc.) · document preview · Upload new option." },
            { label: "Bulk action — Approve KYC (green)", detail: "kyc_status=kyc_approved → dealer can advance to Step 4." },
            { label: "Bulk action — Request Co-Borrower KYC (amber)", detail: "has_co_borrower=true → dealer routed to Step 3." },
            { label: "Bulk action — Request Additional Documents (blue)", detail: "has_additional_docs_required=true → dealer routed to Step 3." },
            { label: "Per-card action — Request Re-upload", detail: "Marks specific verification as failed → dealer receives re-upload prompt." },
            { label: "Bulk action — Reject Lead (red)", detail: "kyc_status=kyc_rejected → dealer can discard or start a new lead." },
            { label: "Mismatch resolution example", detail: "PAN name score 65% (<80%) → admin clicks Request Re-Verification → marks pending_re_review → dealer edits Step 1 name (re-run PAN verify) OR proceeds via co-borrower override after admin approval." },
          ],
        },
        {
          heading: "A-3. Lead Creation Wizard — Step 3: Supporting Docs & Co-Borrower KYC (/dealer-portal/leads/{id}/borrower-consent)",
          rows: [
            { label: "Trigger conditions", detail: "Admin requested co-borrower KYC (has_co_borrower=true) OR admin requested additional documents (has_additional_docs_required=true)." },
            { label: "Co-Borrower KYC", detail: "Field set identical to Step 2 customer KYC. Decentro endpoints called with docFor:'co_borrower'. Consent tracked separately as consent_for=co_borrower.", mono: true },
            { label: "Co-Borrower docs endpoint", detail: "GET /api/kyc/{leadId}/documents?doc_for=co_borrower.", mono: true },
            { label: "Additional Documents request", detail: "Admin creates request via POST .../additional-docs/request with doc-type list + reason. UI shows \"Supporting Documents\" card with labels + reason. Dealer uploads via POST .../upload-document?docFor=customer | co_borrower. Each doc tracked with requested_at / uploaded_at / rejection_reason / upload_status.", mono: true },
            { label: "Finalize Step 3", detail: "POST .../complete-step3 sets step_3_cleared=true → routes to Step 4 if main KYC also approved.", mono: true },
          ],
        },
        {
          heading: "A-3. Lead Creation Wizard — Step 4: Product Selection & Pricing (/dealer-portal/leads/{id}/product-selection)",
          rows: [
            { label: "A. Category / Sub-Category", detail: "Same product cascade as Step 1 (read-only summary if pre-selected)." },
            { label: "B. Battery Selection", detail: "Inventory grid sorted by ageing (fresh → ageing → old). Cards show serial · model · age badge (color-coded) · SOC % · warranty months · price. Click to select (locks)." },
            { label: "C. Charger Selection", detail: "Compatible chargers filtered by voltage / type matching the selected battery. Same display format." },
            { label: "D. Paraphernalia", detail: "Accessories (cable, stand, case, etc.) — count-based qty spinner." },
            { label: "E. Pricing & Margin", detail: "Per item: Gross · GST (9% or 18% by product type) · Net. Dealer margin %age applied → Final price." },
            { label: "F. Submit", detail: "Finance leads → routes to Step 5 (Loan Sanction). Cash leads → confirms sale → immediate dispatch (no Step 5)." },
            { label: "APIs", detail: "GET /api/dealer/leads/{id} (resume) · GET /api/inventory?categoryId=&assetType=battery · GET /api/inventory?categoryId=&assetType=charger&batteryId= · POST /api/leads/{id}/select-product (locks selections, updates lead.product_selection).", mono: true },
          ],
        },
        {
          heading: "A-3. Lead Creation Wizard — Step 5: OTP + Dispatch (Finance only) (/dealer-portal/leads/{id}/step-5)",
          rows: [
            { label: "Scenario A — Loan Sanctioned", detail: "Loan panel shows Loan amount · Down payment · File charge · EMI · Tenure · ROI · Loan File Number." },
            { label: "OTP send", detail: "POST /api/leads/{id}/send-otp generates 6-digit OTP, sends via SMS / WhatsApp to customer.", mono: true },
            { label: "OTP rules", detail: "send_count max 3 · attempt_count max 3 · expires_at 10 min · locked_until 5 min cooldown after 3 failed." },
            { label: "OTP verify", detail: "POST /api/leads/{id}/verify-otp. On success → creates warranty + flips inventory available → dispatched + records dispatch_at → final status sold (auto after warranty creation).", mono: true },
            { label: "Scenario B — Loan Rejected", detail: "Rejection banner with reason. Follow-up: Retry loan application · Select different product · Discard lead." },
            { label: "Lead status lifecycle", detail: "kyc_approved → product_selected → otp_verified → dispatched → sold.", mono: true },
            { label: "Inventory item lifecycle", detail: "available → reserved (on Step 4 select) → dispatched (on OTP verify) → sold (post warranty creation).", mono: true },
          ],
        },
        {
          heading: "A-4. My Drafts (/dealer-portal/leads/drafts)",
          rows: [
            { label: "Purpose", detail: "Save-points for KYC forms in progress (Steps 1–4) — auto-saved every 2 minutes." },
            { label: "Filters", detail: "Search (name / phone, 500 ms debounce) · Progress bucket (All / <25% / 25–75% / >75%)." },
            { label: "Columns", detail: "Customer (name + phone or \"Unnamed customer\" + lead ID) · Progress bar (% + docs uploaded X/Y, consent pending/verified) · Step (1–5) · Consent badge (Pending / In progress / Signed) · Last Saved (relative time)." },
            { label: "Resume action", detail: "Routes to /leads/new?id={leadId}." },
            { label: "Clear draft", detail: "DELETE /api/dealer/leads/drafts/{leadId} — clears the draft cache only; lead row is kept and KYC can be restarted anytime.", mono: true },
          ],
        },
        {
          heading: "A-5. Inventory — Sales-side view (/dealer-portal/inventory)",
          rows: [
            { label: "Note", detail: "Same physical page as Operations > Inventory below. Sales mental model: \"what can I sell next?\". Operations mental model: \"what's in my warehouse?\"." },
            { label: "Incoming Transfers panel", detail: "Blue info box at top showing pending_acknowledgement transfers to this dealer. \"Acknowledge\" button → POST /api/dealer/inventory/acknowledge-transfer { transferId }. Units become available after ack.", mono: true },
            { label: "KPI cards (6)", detail: "Total Units · Available · Reserved · Sold · Low Stock · Out of Stock." },
            { label: "Filters", detail: "Search (product / SKU) · Category (Battery / Charger / Paraphernalia) · Status (clickable KPI cards: All / Low Stock / Out of Stock)." },
            { label: "Columns", detail: "Product · Category · Warehouse · Available · Reserved (amber badge if >0) · Sold · Unit Price (₹) · Stock Value (₹, available × unit_price) · Received (DD-MMM-YYYY) · Status." },
            { label: "Export CSV", detail: "Generates CSV with active filters, date-stamped filename." },
            { label: "Status transitions", detail: "available → reserved (lead qualification) → dispatched (Step 5 OTP) → sold (post warranty). available → written_off (damage/loss).", mono: true },
          ],
        },
      ],
    },
    {
      title: "B. Operations Navbar",
      sections: [
        {
          heading: "B-1. Orders from OEM (/dealer-portal/orders)",
          rows: [
            { label: "Purpose", detail: "Manages purchase orders placed to the OEM for inventory replenishment (incoming stock pipeline)." },
            { label: "List view", detail: "Order ID · OEM · Order Date · Status (placed / confirmed / shipped / received) · Item count · Total Value." },
            { label: "Detail view", detail: "Line items per SKU · expected delivery · invoice attachments · acknowledgement actions." },
          ],
        },
        {
          heading: "B-2. Inventory — Operations-side view (/dealer-portal/inventory)",
          rows: [
            { label: "Same page as Sales > Inventory", detail: "Both nav items converge on the single Inventory page — sidebar sections (SALES vs OPERATIONS) are organisational labels only. See A-5 above for full field detail." },
            { label: "Operations focus", detail: "Operations users tend to use the Low Stock / Out of Stock KPI filters + Export CSV for warehouse reconciliation, whereas Sales users tend to filter by Available + Category for next-sale planning." },
          ],
        },
        {
          heading: "B-3. Service Management (/dealer-portal/service)",
          rows: [
            { label: "Purpose", detail: "Track after-sales service requests, warranty claims, and field service jobs (per BRD after-sales records)." },
            { label: "Typical fields", detail: "Service request ID · Customer · Battery serial · Issue type · Assigned engineer · Status (open / in-progress / resolved / closed) · Created / Resolved timestamps." },
          ],
        },
        {
          heading: "B-4. Campaigns (/dealer-portal/campaigns/new)",
          rows: [
            { label: "Purpose", detail: "Dealer-initiated marketing / coupon campaigns to drive lead generation (per BRD coupon-distribution flow)." },
            { label: "Typical fields", detail: "Campaign name · Target customer segment · Coupon code(s) · Discount / offer terms · Start / End dates · Distribution channel (SMS / WhatsApp / Email)." },
          ],
        },
      ],
    },
  ],
};

// ============================================================================
// CONTENT — NBFC ONBOARDING
// ============================================================================

const NBFC_ONBOARDING: Compartment = {
  tabTitle: "NBFC Onboarding",
  titleText: "4.  NBFC Onboarding — Full 6-Step Admin Wizard",
  color: COLOR.deepBlue,
  subHeaders: [
    {
      title: "Step 1 — Master Details (/admin/nbfc/new)",
      sections: [
        {
          heading: "Identity section",
          rows: [
            { label: "Legal Name", detail: "Free text. Required." },
            { label: "Short Name", detail: "Free text. Required." },
            { label: "NBFC Type", detail: "Dropdown — NBFC-ICC · NBFC-MFI · NBFC-Factor · HFC · Scheduled Bank · Cooperative Bank · Other." },
            { label: "RBI Registration No", detail: "Pattern: N-DD.DDDDD.DD.DD.DDDD.DDDDD.DD.", mono: true },
            { label: "CIN, GST Number, PAN Number", detail: "Identity numbers — pattern-validated." },
          ],
        },
        {
          heading: "Address section (3-col grid)",
          rows: [
            { label: "Address Line 1, Address Line 2", detail: "Street address." },
            { label: "City, District, State, Pin Code", detail: "Pin Code 6-digit numeric." },
          ],
        },
        {
          heading: "Primary Contact section",
          rows: [
            { label: "Primary Contact Name, Email, Phone", detail: "Main point of contact at the NBFC for onboarding." },
          ],
        },
        {
          heading: "Grievance & Nodal Officer section",
          rows: [
            { label: "Grievance Officer Name", detail: "Required for RBI compliance." },
            { label: "Helpline (phone)", detail: "Public-facing grievance helpline." },
            { label: "Grievance URL", detail: "Public-facing grievance redressal page URL." },
            { label: "Nodal Officer Name", detail: "RBI-mandated nodal contact." },
          ],
        },
        {
          heading: "Partnership section",
          rows: [
            { label: "Partnership Date", detail: "Date picker." },
            { label: "Active Geographies", detail: "Comma-separated state codes, e.g. \"TN, KA, AP\"." },
            { label: "FLDG Terms (checkbox)", detail: "First-Loss-Default-Guarantee agreement flag." },
          ],
        },
        {
          heading: "Persistence & submit",
          rows: [
            { label: "localStorage draft key", detail: "itarang:nbfc:new:draft-v1 — auto-saves form state across page reloads.", mono: true },
            { label: "Save Draft", detail: "Saves to localStorage; user can return later." },
            { label: "Submit for CEO Approval", detail: "Persists the master record and redirects to Step 2 — Documents (NBFC ID in URL)." },
          ],
        },
      ],
    },
    {
      title: "Step 2 — Compliance Documents (/admin/nbfc/[nbfcId]/documents)",
      sections: [
        {
          heading: "Required compliance documents",
          rows: [
            { label: "Board Resolution", detail: "Required." },
            { label: "Certificate of Incorporation", detail: "Required." },
            { label: "Memorandum & Articles of Association (MoA / AoA)", detail: "Required." },
            { label: "RBI License Copy", detail: "Required." },
            { label: "Last 3 Years Audited Financial Statements", detail: "Required." },
            { label: "Latest Bank Statement", detail: "Required." },
            { label: "Directors' List (DIN certified)", detail: "Required." },
            { label: "Grievance Redressal Policy", detail: "Required." },
            { label: "NBFC Charter / Operational Manual", detail: "Required." },
          ],
        },
        {
          heading: "Upload behaviour",
          rows: [
            { label: "Drag-and-drop / click-to-upload", detail: "Shows file name, size, verification status. Re-uploadable if rejected." },
            { label: "Correction flags", detail: "Displays correction flags from CEO if documents were flagged during a prior review round." },
            { label: "Buttons", detail: "Save Draft · Next (advances to Step 3 — LSP Agreement)." },
          ],
        },
      ],
    },
    {
      title: "Step 3 — LSP Agreement (/admin/nbfc/[nbfcId]/lsp-agreement)",
      sections: [
        {
          heading: "NBFC Signers block (blue section)",
          rows: [
            { label: "Default", detail: "1 NBFC signer (cannot be removed)." },
            { label: "Per signer row", detail: "Full Name · Email · Designation · Identity Document (PDF / JPG / PNG ≤ 5 MB)." },
            { label: "+ Add another NBFC signer", detail: "Dynamically-added rows show a trash icon to remove." },
          ],
        },
        {
          heading: "iTarang Signers block (teal section)",
          rows: [
            { label: "Default", detail: "1 iTarang signer (cannot be removed)." },
            { label: "Per signer row", detail: "Full Name · Email · Designation · Identity Document." },
            { label: "+ Add another iTarang signer", detail: "Numbered avatars reflect the global sequential signing order." },
          ],
        },
        {
          heading: "Agreement template & submit",
          rows: [
            { label: "Blank agreement template upload", detail: "PDF / JPG / PNG. Required." },
            { label: "Signing order display", detail: "Automatically reflows as signers are added or removed." },
            { label: "Submit", detail: "POST /api/admin/nbfc/[nbfcId]/lsp-agreement/initiate with the signer array + template URL → routes to Step 4 — Approval.", mono: true },
          ],
        },
      ],
    },
    {
      title: "Step 4 — Approval — CEO Gate (/admin/nbfc/[nbfcId]/approval)",
      sections: [
        {
          heading: "Read-only review panels",
          rows: [
            { label: "Master Details summary", detail: "Legal Name, RBI Reg, Address, Contacts." },
            { label: "Compliance Documents section", detail: "Preview tile per uploaded doc." },
            { label: "Signers section", detail: "NBFC signers + iTarang signers with identity docs." },
            { label: "Agreement Template preview", detail: "PDF / image inline preview." },
            { label: "LSP Signer Status panel", detail: "Signing progress (X of N signed) with individual signer status pills." },
          ],
        },
        {
          heading: "Outstanding Corrections panel",
          rows: [
            { label: "Prior-round flags", detail: "If CEO flagged items in a previous round, they are displayed here for the submitter's acknowledgement." },
          ],
        },
        {
          heading: "NbfcFinalApprovalPanel — CEO-only buttons",
          rows: [
            { label: "Approve", detail: "Transitions status to active, sets activated_at timestamp.", mono: true },
            { label: "Reject", detail: "Transitions to rejected with a captured reason.", mono: true },
            { label: "Request Correction", detail: "Creates a correction round with the flagged items; submitter must re-supply.", mono: true },
          ],
        },
      ],
    },
    {
      title: "Step 5 — Activation",
      sections: [
        {
          heading: "What happens on approval",
          rows: [
            { label: "Status transition", detail: "Status moves to active; activated_at timestamp recorded.", mono: true },
            { label: "Directory promotion", detail: "NBFC now appears in the main Directory (no longer only in \"My Submitted Drafts\")." },
            { label: "Credentials issuance", detail: "Credentials sent to the NBFC per the 12-step activation flow (per BRD)." },
          ],
        },
        {
          heading: "Status lifecycle (overall)",
          rows: [
            { label: "Happy path", detail: "draft → pending_admin_review → approved → active", mono: true },
            { label: "Side states", detail: "rejected (terminal) · request_correction (cycles submitter back to flagged steps).", mono: true },
          ],
        },
      ],
    },
  ],
};

// ============================================================================
// CONTENT — NBFC DASHBOARD
// ============================================================================

const NBFC_DASHBOARD: Compartment = {
  tabTitle: "NBFC Dashboard",
  titleText: "5.  NBFC Dashboard — Portfolio, Risk, Recovery & Compliance",
  color: COLOR.emerald,
  subHeaders: [
    {
      title: "1. Portfolio Overview (/nbfc/portfolio) — Command Centre",
      sections: [
        {
          heading: "KPI cards (4)",
          rows: [
            { label: "Active Loans", detail: "Count of disbursed loans not yet closed; includes MoM / QoQ trend delta." },
            { label: "At-Risk", detail: "Number of loans flagged by risk rules; percentage of book." },
            { label: "Delinquency Rate", detail: "Percentage of portfolio with DPD > 0; includes trend delta." },
            { label: "Recovery in Motion", detail: "Count + INR value of batteries in the pipeline (stages: needs_inspection through ready_for_auction)." },
          ],
        },
        {
          heading: "Supporting sections",
          rows: [
            { label: "Navigation counts strip", detail: "Risk alerts open · Total leads · Recovery open (clickable drill-through)." },
            { label: "Alert feed", detail: "Merged telemetry + risk alerts (sources: nbfc_risk_alerts + telemetry_alerts). Each alert shows severity (critical / warning / info), title, battery serial, borrower name, city, created_at.", mono: true },
            { label: "Weekly stats panel", detail: "EMI settled · new risk alerts · recovery added · immobilisations executed (last 7 days)." },
            { label: "Regional risk", detail: "City-by-city loan count, at-risk count, at-risk %." },
            { label: "Recent actions", detail: "Aggregates by action type — Payment Reminder, Field Visit, Immobilisation, Restructuring, Flag for Recovery — with counts." },
          ],
        },
        {
          heading: "Data sources & API",
          rows: [
            { label: "Tables", detail: "nbfc_loans · loan_sanctions · borrower_risk_scores · nbfc_recovery_pipeline · nbfc_borrower_actions · nbfc_immobilisation_actions · telemetry_alerts · emi_schedules.", mono: true },
            { label: "Endpoint", detail: "GET /api/nbfc/portfolio/command-centre — returns CommandCentreData with KPIs, nav counts, alert feed, weekly stats, regional, recent actions, computed_at.", mono: true },
          ],
        },
        {
          heading: "Key Workflows",
          rows: [
            { bullet: "W1.", label: "Daily Portfolio Briefing", detail: "User opens /nbfc/portfolio at start of day → scans KPI tiles (active loans, at-risk, delinquency, recovery) → reviews Alert Feed for overnight incidents → checks Regional Risk for geographic hot-spots → reviews Recent Actions to see what ops did yesterday. Read-only dashboard, self-refreshing." },
            { bullet: "W2.", label: "Drill Down to Specific Risk Segment", detail: "User clicks a KPI card or a region in Regional Risk → URL query params change → dashboard filters to that segment → user clicks \"Go to Battery Monitoring\" or \"Go to Risk Alerts\" in Command Nav Strip → deep-dives into batteries / risk cards for the cohort." },
          ],
        },
        {
          heading: "Permissions",
          rows: [
            { label: "View Portfolio Overview", detail: "All NBFC roles (owner · risk_head · nbfc_manager · nbfc_operator · finance). Read-only — no state changes." },
          ],
        },
      ],
    },
    {
      title: "2. Lead Intelligence (/nbfc/leads)",
      sections: [
        {
          heading: "Filter bar (11 controls)",
          rows: [
            { label: "CDS Band", detail: "Low (<40) · Mid (40–70) · High (≥70) · No score — computed nightly." },
            { label: "Geography", detail: "State dropdown (populated from data)." },
            { label: "Product", detail: "Financed product model (populated from data)." },
            { label: "Dealer", detail: "Dealer company name (populated from data)." },
            { label: "DPD Bucket", detail: "Current (0) · 1–30 · 31–60 · 60+ days." },
            { label: "EMI Status", detail: "Overdue · Upcoming · None (derived from emi_schedules ledger).", mono: true },
            { label: "Loan Amount (₹)", detail: "Min / Max range filter." },
            { label: "Sort By", detail: "Newest/Oldest · Amount high/low · CDS high/low · Customer A→Z · Most overdue · Current DPD high→low · Next EMI soonest." },
            { label: "Created From / To", detail: "Inclusive date range (end at 23:59)." },
            { label: "Search", detail: "Full-text — loan ID, serial, borrower name, dealer, file number." },
            { label: "Per Page", detail: "20 / 50 / 100." },
          ],
        },
        {
          heading: "Status chips & table",
          rows: [
            { label: "Status chips (6 at top)", detail: "Sanctioned · Dealer Approved · Disbursed · Active · Overdue · Closed — click to toggle filter and reset to page 1." },
            { label: "Master table columns", detail: "Loan Ref · Customer (coalesce loan_files.borrower_name → loan_applications.applicant_name) · Dealer · Battery Serial (nbfc_loans.vehicleno) · Loan Amount · Status · Current DPD · Outstanding · Overdue Days · Next EMI Date · CDS · CDS Band · City · State · Product.", mono: true },
            { label: "CSV Export", detail: "Downloads filtered + sorted rows." },
            { label: "Row click", detail: "Opens read-only detail drawer with full loan context." },
            { label: "Rendering", detail: "Server-rendered — no additional API calls; all joins happen at page load." },
          ],
        },
        {
          heading: "Key Workflows",
          rows: [
            { bullet: "W1.", label: "Screen New Loan Cohort by Risk Band", detail: "User clicks CDS Band dropdown → selects Mid → applies. Narrows by Geography (e.g. Karnataka) + DPD bucket (60+ days). Result: tight cohort \"11 mid-risk loans in Karnataka with 60+ DPD\" → CSV export → hand to field agents." },
            { bullet: "W2.", label: "Search Loan by Reference or Serial", detail: "User types partial Loan File Number or battery serial into Search → Apply → table filters to matching rows → click row to open read-only detail drawer (KYC, product, EMI schedule, audit trail linked to /nbfc/audit?entityId=)." },
            { bullet: "W3.", label: "Bulk Action Preparation", detail: "Apply multi-filter (Status=Overdue + DPD=60+ + CDS=High) → set Per Page=100 → click LeadsCsvButton → export filtered list → pass CSV to recovery operations team." },
          ],
        },
        {
          heading: "Permissions",
          rows: [
            { label: "View Lead Intelligence", detail: "All NBFC roles — read-only listing." },
            { label: "CSV Export", detail: "All roles. Some tenants may audit risk_head / owner exports separately." },
          ],
        },
      ],
    },
    {
      title: "3. Battery Monitoring (/nbfc/batteries) — Fleet Telemetry",
      sections: [
        {
          heading: "KPI tiles (4) — real-time alert state",
          rows: [
            { label: "Critical", detail: "Open alerts AND CDS ≥ mid_high threshold; click to filter." },
            { label: "Warning", detail: "CDS ≥ low_mid (excluding Critical overlap)." },
            { label: "Info", detail: "CDS < low_mid (low risk)." },
            { label: "Geo Variation", detail: "Batteries with valid GPS coordinates (lat / lon not null)." },
          ],
        },
        {
          heading: "Filter bar",
          rows: [
            { label: "EMI", detail: "All · On time · Overdue." },
            { label: "City", detail: "Dropdown (from leads.city)." },
            { label: "Status (freshness)", detail: "All · Fresh (≤5 min) · Idle (5 min–1 day) · Stale (>1 day) · Offline · Never reported." },
            { label: "Search", detail: "Battery serial, IMEI, borrower name (client-side match)." },
            { label: "Risk preserve", detail: "Hidden input preserves ?risk= param when set by tile clicks." },
          ],
        },
        {
          heading: "Master table columns",
          rows: [
            { label: "Identity", detail: "Vehicle serial · Loan ID · Borrower · Dealer · City · IMEI (from inventory.iot_imei_no).", mono: true },
            { label: "Loan", detail: "EMI amount (₹) · Current DPD." },
            { label: "Live telemetry", detail: "SOC % · SOH % · Pack temp (°C) — fetched from VPS vehicle_state.", mono: true },
            { label: "Risk", detail: "CDS / PCI / Confidence (from borrower_risk_scores).", mono: true },
            { label: "Freshness", detail: "Last seen timestamp + badge (fresh / idle / stale / offline / never)." },
            { label: "Open alerts", detail: "Rollup from telemetry_alerts.", mono: true },
            { label: "Last action badge", detail: "Immobilization Pending / Rejected / Force Majeure / Immobilised (from nbfc_borrower_actions).", mono: true },
          ],
        },
        {
          heading: "Case Workspace Sheet (right-side drawer on row click)",
          rows: [
            { label: "Identity cards (8)", detail: "Customer · Dealer · Loan ID · Outstanding · Loan Start · Tenure (months) · Phone · IMEI · City." },
            { label: "Why Flagged panel", detail: "Confidence level, last-updated timestamp, reason tags, CDS / PCI chips, immobilisation-eligibility badge." },
            { label: "Lazy-loaded tabs", detail: "Telemetry (SOC/SOH/pack temp history, live GPS, open alerts) · EMI History · Usage Pattern · Action History." },
            { label: "Why This Matters panel", detail: "Default probability %, evidence confidence, data freshness, knowledge-limits text." },
            { label: "Recommended Actions (radio)", detail: "Payment Reminder (channel by EMI stage) · Field Visit · Immobilisation (dual-approval + mandatory borrower notice per §6.4.3) · Restructuring." },
            { label: "Continue to Action", detail: "Opens the selected modal to execute the action." },
          ],
        },
        {
          heading: "API endpoints (case workspace)",
          rows: [
            { label: "Case detail", detail: "GET /api/nbfc/loans/{loanSanctionId}/case-detail", mono: true },
            { label: "EMI schedule (lazy)", detail: "GET /api/nbfc/loans/{loanSanctionId}/emi-schedule", mono: true },
            { label: "Action history (lazy)", detail: "GET /api/nbfc/loans/{loanSanctionId}/action-history", mono: true },
            { label: "Live telemetry", detail: "GET /api/nbfc/iot/battery/{serialNumber}/daily-summaries · /soc · /state", mono: true },
          ],
        },
        {
          heading: "VPS degradation",
          rows: [
            { label: "Fallback behaviour", detail: "If the VPS is unreachable, the page renders a banner and shows portfolio rows only (live metrics blanked)." },
          ],
        },
        {
          heading: "Key Workflows",
          rows: [
            { bullet: "W1.", label: "Identify and Act on Critical Cases", detail: "Critical KPI tile shows 23 batteries → user clicks tile → table filters to open_alerts>0 AND cds≥mid_high. User scans rows → spots \"TK-4521\" with Immobilisation Pending badge → clicks row → CaseWorkspaceSheet opens. Reviews Identity cards · WhyFlagged panel · Telemetry / EMI / Usage / Action tabs · WhyThisMatters panel. Selects \"Request immobilisation\" radio → clicks Continue to Action → ImmobilisationModal opens → confirms mandatory Borrower Notice (RBI DLD 2025) checkbox → Submit → POST /api/nbfc/actions/immobilisation/request → creates dual-approval request → user redirected to /nbfc/audit with the new pending entry." },
            { bullet: "W2.", label: "Monitor Battery Health Decay", detail: "User filters Status=Stale (last GPS > 1 h) → table shows 14 stale units → spots \"TK-5833\" with SOH trending 85% → 72% over 2 weeks (visible in Telemetry tab). Selects \"Request field visit\" → FieldVisitModal opens → assigns agent (\"Rajesh Kumar — Bangalore Zone\") + notes (\"Check pack temperature; possible thermal runaway risk\") → POST /api/nbfc/actions/field-visit → logged to action history + Audit Log → agent notified in-app + SMS." },
            { bullet: "W3.", label: "Geo-Cluster Recovery (Offline Devices)", detail: "Filter Risk=Geo to see 156 batteries with lat/lon → then Critical + Status=Offline (>8 h no GPS) → result: 7 critical offline batteries clustered in Hyderabad → user flags bulk immobilisation → POST /api/nbfc/actions/immobilisation/request with note \"Cluster recovery\" → dual-approval gate fires → on approval, ops team receives recovery-kit dispatch instruction." },
          ],
        },
        {
          heading: "Permissions",
          rows: [
            { label: "View Battery Monitoring", detail: "All NBFC roles." },
            { label: "Request Payment Reminder", detail: "nbfc_operator · nbfc_manager · risk_head · owner." },
            { label: "Request Field Visit", detail: "nbfc_manager · risk_head · owner." },
            { label: "Request Immobilisation", detail: "risk_head · owner ONLY (dual-approval gate)." },
            { label: "Request Restructuring", detail: "risk_head · finance · owner." },
          ],
        },
      ],
    },
    {
      title: "4. Risk Alerts (/nbfc/risk) — Hypothesis-Driven Cards",
      sections: [
        {
          heading: "Severity tabs (3)",
          rows: [
            { label: "High (red)", detail: "Critical anomalies requiring immediate action." },
            { label: "Warning (amber)", detail: "Medium-severity findings." },
            { label: "Ok (green)", detail: "Low-severity / informational findings." },
            { label: "Tab counts", detail: "Each tab shows a count badge; cards inside are sorted by severity rank + affected count (descending), capped at 20 visible." },
          ],
        },
        {
          heading: "Risk card fields",
          rows: [
            { label: "Title / Description / Source", detail: "Source: hand-coded vs LLM." },
            { label: "Severity badge", detail: "high / warn / ok." },
            { label: "Finding summary", detail: "Plain text — what was observed." },
            { label: "Affected count / total", detail: "e.g. \"12 of 340 loans\"." },
            { label: "Evidence", detail: "Sample rows table, chart if available, notes." },
            { label: "Last run timestamp", detail: "Null if hand-coded fallback was used." },
          ],
        },
        {
          heading: "Actions",
          rows: [
            { label: "Card click", detail: "Opens RiskCardDrawer with expanded evidence, chart visualisation, sample data." },
            { label: "Rerun button (top-right)", detail: "POST /api/nbfc/risk/run — re-evaluates all hypotheses; updates risk_card_runs with latest severity, finding_summary, evidence_json. Falls back to hand-coded evaluators for hypotheses with no stored run.", mono: true },
          ],
        },
        {
          heading: "Risk Action Framework (matrix below tabs)",
          rows: [
            { label: "Send Payment Reminder", detail: "Single user · Reversible (Yes) · Audit log (auto)." },
            { label: "Request Field Visit", detail: "Single user · Reversible (Yes) · Audit log (auto)." },
            { label: "Request Immobilisation", detail: "Dual-approval · Reversible (Yes — can be reversed via unimmobilise) · Audit log (detailed)." },
            { label: "Review for Loan Restructuring", detail: "Single user · Reversible (Depends on approval) · Audit log (manual)." },
            { label: "Flag for Recovery", detail: "Dual-approval · Reversible (No — terminal) · Audit log (detailed)." },
          ],
        },
        {
          heading: "Borrower Notice Preview (RBI Digital Lending Directions 2025)",
          rows: [
            { label: "Mandatory components (5)", detail: "Lender name (from nbfc_tenants.nbfc_legal_name) · Notice title + reason · Remedies available · Grievance contact (URL + helpline) · Reversibility statement.", mono: true },
            { label: "Gate", detail: "Checkbox \"I confirm the notice is accurate\" must be ticked before any immobilisation request can be submitted." },
          ],
        },
        {
          heading: "Key Workflows",
          rows: [
            { bullet: "W1.", label: "Daily Risk Hypothesis Scan", detail: "Risk Head opens /nbfc/risk at 09:00 → RerunButton shows \"Last run: 05:30 — 2h 30m old\" → clicks RerunButton → POST /api/nbfc/risk/run → cards re-evaluate (hand-coded + LLM generators) → within ~60s new cards appear. Risk Head scans Critical tab → sees \"Recurring 60+ DPD Patterns\" (5 of 487 loans) → clicks Drill into 5 loans → routed to /nbfc/batteries with filters pre-applied → reviews + flags for field visit or immobilisation." },
            { bullet: "W2.", label: "Investigate Specific Hypothesis", detail: "User clicks Medium-severity card \"Geospatial Anomaly Detected\" → card expands showing \"17 of 487 batteries operating outside registered service radius\" + evidence chips (Bangalore region, 350 km drift) → clicks Drill into 17 loans → routed to /nbfc/batteries?risk=geo → table shows the 17 batteries → Risk Head assigns field visit to verify (operational compliance or fraud)." },
            { bullet: "W3.", label: "Monitor Evaluation Freshness", detail: "Card shows \"Last run: 8h 14m ago\" → user clicks RerunButton → if evaluators fail (VPS unreachable) an error banner appears \"IoT VPS unreachable — some risk cards unavailable\" → user notes the issue and escalates to platform ops. Non-VPS cards still render with stale data marked unavailable." },
          ],
        },
        {
          heading: "Permissions",
          rows: [
            { label: "View Risk Alerts", detail: "All NBFC roles." },
            { label: "RerunButton (manual evaluation trigger)", detail: "owner · risk_head ONLY." },
          ],
        },
      ],
    },
    {
      title: "5. Recovery & Auction (/nbfc/recovery) — Repossession Pipeline",
      sections: [
        {
          heading: "Recovery Pipeline (headline metrics)",
          rows: [
            { label: "Value Locked (₹)", detail: "Sum of estimated_recovery_value for batteries in needs_inspection / refurbishable / ready_for_auction.", mono: true },
            { label: "Est. Recovery (₹)", detail: "Sum across all stages except scrap." },
            { label: "Recovery Rate (%)", detail: "resold_count / (resold_count + scrap_count)." },
            { label: "Stage cards (4)", detail: "Needs Inspection · Refurbishable · Scrap · Resold — each shows count + icon." },
          ],
        },
        {
          heading: "Auction Marketplace — live lots grid",
          rows: [
            { label: "Lot card fields", detail: "Lot code · Capacity · Avg SOH % · Age (months) · Quantity · Base price (₹) · Bid increment (₹) · Current bid · Bidder count · Time remaining (client-side countdown)." },
            { label: "Your Last Bid / Auto-Bid Max", detail: "Shows this tenant's highest bid and active auto-bid ceiling if set." },
            { label: "PlaceBidModal", detail: "Enter bid amount (must exceed current bid by increment); place binding bid; activate auto-bid." },
            { label: "Battery Evaluation panel (sticky sidebar)", detail: "Lists batteries in needs_inspection stage; opens quick evaluation wizard." },
          ],
        },
        {
          heading: "Battery Evaluation wizard",
          rows: [
            { label: "Transitions", detail: "Drag candidates from needs_inspection to refurbishable / scrap / ready_for_auction.", mono: true },
            { label: "SOH guardrail", detail: "Move to refurbishable is BLOCKED if SOH < 70% (per BRD §6.1.7)." },
            { label: "Endpoint", detail: "PATCH /api/nbfc/recovery/{id}/stage { stage } per transition.", mono: true },
          ],
        },
        {
          heading: "Post-Auction Settlement",
          rows: [
            { label: "Headline metrics", detail: "Total Value (₹) · Recovery Rate (%) · Premium Over Base (%)." },
            { label: "Settlements table", detail: "Lot code · Final price (₹) · Winner tenant · Status (delivered / pending / cancelled) · Updated_at." },
          ],
        },
        {
          heading: "Buyback Requests (E-118)",
          rows: [
            { label: "Read-only table", detail: "Customer · Battery serial · SOH % · Requested_at · Evaluation status (pending / accepted / rejected) · Offer amount (₹) · Status (active / fulfilled / expired)." },
          ],
        },
        {
          heading: "Operations Workspace — Kanban board",
          rows: [
            { label: "Columns (one per stage)", detail: "Needs Inspection · Refurbishable · Ready for Auction · Resold · Scrap." },
            { label: "Card per battery", detail: "Serial · Borrower · Estimated recovery value · Live SOH % · Age (days)." },
            { label: "Drag-and-drop", detail: "Enforces allowed transitions + SOH guardrail." },
            { label: "Right-click → Request Immobilisation", detail: "Opens ImmobilisationRequestDialog." },
          ],
        },
        {
          heading: "Immobilisation Requests table",
          rows: [
            { label: "Columns", detail: "Created · Loan ID · Reason code · Status · Expires." },
            { label: "Statuses", detail: "Pending sales_head · Approved (not yet executed) · Executed (approval + nbfc_immobilisation_actions row written) · Rejected · Expired.", mono: true },
            { label: "Approval flow", detail: "iTarang sales_head approves via dual-approval gate; on approval, the device-immobilisation row is created." },
          ],
        },
        {
          heading: "Action modals",
          rows: [
            { label: "ImmobilisationRequestDialog", detail: "Reason text (required, ≥20 chars) + Borrower Notice Preview (mandatory, non-dismissible per RBI) + confirmation checkbox → POST /api/nbfc/actions/immobilisation/request.", mono: true },
            { label: "PaymentReminderModal", detail: "Reason dropdown — EMI due today (SMS) · EMI overdue 1–7 days (SMS) · 8–30 days (WhatsApp) · Final warning (Email) → POST /api/nbfc/actions/payment-reminder.", mono: true },
            { label: "FieldVisitModal", detail: "Request a field visit with reason text." },
            { label: "RestructuringModal", detail: "Initiate loan restructuring review." },
          ],
        },
        {
          heading: "Key Workflows",
          rows: [
            { bullet: "W1.", label: "Move Battery Through Recovery Pipeline", detail: "Battery \"TK-3344\" in Needs Inspection column after recovery flag → recovery specialist drags it to Refurbishable → system checks VPS SOH. If SOH<70%: drag fails with toast \"Cannot refurbish: SOH 68% < 70% minimum\". If SOH>70%: PATCH /api/nbfc/recovery/[id]/stage fires → nbfc_recovery_pipeline updates → battery auto-moves to Ready for Auction." },
            { bullet: "W2.", label: "Create and Auction a Lot", detail: "Ops manager selects 4 batteries from Ready for Auction (TK-3344, TK-3567, TK-4001, TK-5203 — 2022, avg SOH 76%, 24 months). Clicks Create Lot → system fetches estimated_recovery_value per battery → BatteryEvaluationPanel shows aggregated specs (4 units, 60 kWh, 76% SOH) → manager reviews risk classification (Medium) → types reserve price ₹84,000 → clicks Create Lot → POST /api/nbfc/auction/lots → new lot_id → appears in auction grid." },
            { bullet: "W3.", label: "Place a Bid", detail: "Lot LOT-0247 live with 3 bids (current ₹98,500, 4 bidders, countdown 08:32:14). User clicks lot card → BatteryEvaluationPanel populates → sees \"Your last bid: ₹96,000 (not highest)\" → clicks Place Bid → PlaceBidModal: \"Current bid: ₹98,500 · Increment: ₹500 · Auto-bid max: none\" → types ₹99,500 → Submit → POST /api/nbfc/auction/lots/[LOT-0247]/bid → grid updates instantly → user notified of outbids via in-app + email." },
            { bullet: "W4.", label: "Settle a Sold Lot", detail: "Auction ends. Final bid ₹1,24,700 from ACE Electronics Ltd. → lot auto-transitions to Resold in kanban → Settlement section shows new row for LOT-0145 with status \"Payment Pending\" → finance waits for buyer's bank transfer → once cleared (bank API or manual recon) → user clicks settlement row → detail drawer → clicks Mark Paid → POST /api/nbfc/auction/settlements/[id] with status=paid → batteries move to Scrap or Logistics Hold (per buyer terms) → recovery value finalized + added to portfolio KPI." },
            { bullet: "W5.", label: "Handle Buyback Request", detail: "Borrower \"Rajesh Kumar\" (loan TK-3344) submits buyback request: requested ₹45,000 (50% of outstanding). Request appears in BuybackRequestsTable with status \"Pending\". Risk Head clicks row → drawer shows borrower contact, outstanding balance, request price, justification (\"Paid 18 of 24 EMIs, requesting settlement buyback\") → enters counter-offer ₹42,000 → Submit → status \"Counter Offered\" → borrower notified to accept/reject. If accepted, settlement workflow proceeds." },
          ],
        },
        {
          heading: "Permissions",
          rows: [
            { label: "View Recovery & Auction", detail: "All NBFC roles." },
            { label: "Move Battery in Kanban", detail: "nbfc_manager · owner." },
            { label: "Create Lot", detail: "nbfc_manager · owner." },
            { label: "Place Bid", detail: "finance · nbfc_manager · owner (depends on buyer role config)." },
            { label: "Mark Lot Paid / Settle", detail: "finance · owner." },
            { label: "Counter-offer Buyback", detail: "risk_head · finance · owner." },
          ],
        },
      ],
    },
    {
      title: "6. Audit Log (/nbfc/audit) — Compliance & Evidence",
      sections: [
        {
          heading: "Sticky filter bar (client-side on loaded data)",
          rows: [
            { label: "Date Range", detail: "From / To (ISO 8601 dates, optional)." },
            { label: "Action Type", detail: "Dropdown — payment_reminder · field_visit · immobilisation · restructuring · flag_for_recovery · risk_run · score_override · pii_access · ...", mono: true },
            { label: "Status", detail: "pending · approved · rejected · executed · expired · ...", mono: true },
            { label: "Requested By", detail: "User autocomplete from requesters list." },
            { label: "Entity ID", detail: "Loan ID or battery serial (debounced 300 ms)." },
          ],
        },
        {
          heading: "Master table (dense fintech style)",
          rows: [
            { label: "Columns", detail: "Created (ISO 8601, mono) · Action (from ACTION_LABELS map) · Entity (loan sanction ID or serial) · User · Status (color-coded pill) · Affected." },
            { label: "Row click", detail: "Opens AuditLogDetailDrawer with full event JSON payload + LeadAuditTimeline (chronological events for that lead)." },
          ],
        },
        {
          heading: "CSV Export (DPDPA 2023 §5.1)",
          rows: [
            { label: "ExportPurposeModal", detail: "Requester must declare purpose (\"Compliance audit\", \"Risk assessment\", etc.) before export." },
            { label: "Export contents", detail: "Filtered rows + filter criteria + exported_at + declared purpose. Filename audit-log-{tenant-slug}-{exported_at}.csv.", mono: true },
          ],
        },
        {
          heading: "Data sources & API",
          rows: [
            { label: "Tables merged", detail: "nbfc_audit_log + nbfc_borrower_actions + nbfc_immobilisation_actions.", mono: true },
            { label: "Endpoint", detail: "GET /api/nbfc/audit-log?from=&to=&action=&status=&requestedBy=&entityId=&page=&limit=50&format=csv|json.", mono: true },
            { label: "Pagination", detail: "50 rows per page; Prev/Next; total computed server-side." },
          ],
        },
        {
          heading: "Key Workflows",
          rows: [
            { bullet: "W1.", label: "Compliance Audit — Find All Rejections", detail: "Auditor opens /nbfc/audit → sets Status=Rejected + Date range=\"Last 30 days\" → applies → table shows 14 rejected actions (6 immobilisation, 5 field visit cancellations, 3 restructuring) → clicks a row → reviews rejection reason in drawer (e.g. \"Borrower already in settlement negotiation\") → notes approver (\"Ops Head — Priya Sharma\") → documents findings in external compliance log." },
            { bullet: "W2.", label: "Investigate a Dual-Approval Action", detail: "User clicks row for immobilisation_request with status=Approved → drawer opens. Approval chain shows: Initiated by risk_head@tenant.com at 14:32:15 → Risk Head signature at 14:45:22 → Ops signature at 15:02:44 → Borrower Notice text previewed → Action: immobilisation request created, device immobiliser activated, audit log recorded. User exports this single row with purpose \"Borrower dispute resolution — loan TK-4521\" → sent to borrower's grievance committee." },
            { bullet: "W3.", label: "Track an Entity Across All Actions", detail: "User types Loan Sanction ID (\"a8c9d7e2-…\") into Entity ID filter → applies → table shows full loan lifecycle ordered by timestamp: sanction (2026-02-10) → disbursal (2026-02-12) → payment reminder 1 (2026-04-15, auto) → field visit request (2026-04-25, approved) → immobilisation request (2026-05-08, pending dual approval). Click any row → LeadAuditTimeline drawer also shows lead creation, product selection, KYC from the CRM side." },
            { bullet: "W4.", label: "Export Audit Log with Purpose Declaration (DPDPA 2023)", detail: "Finance Head opens /nbfc/audit → applies May 2026 + payment_reminder filters → 287 records → clicks Export → ExportPurposeModal opens: \"287 events will be exported\" + RBI DLD 2025 §6.3.5 subtitle + Purpose field (min 10 chars) + confirmation checkbox \"This export is for legitimate use only, consistent with RBI DLD 2025 and DPDPA 2023\". Types purpose \"Monthly reconciliation with borrowers for May disbursements\" → Export → CSV downloads → POST .../audit-log-export/initiate creates audit_log_exports row (timestamp, user_id, tenant_id, purpose, row_count, filters_used)." },
          ],
        },
        {
          heading: "Permissions",
          rows: [
            { label: "View Audit Log", detail: "All NBFC roles." },
            { label: "Filter by User / Approver", detail: "owner · risk_head (can filter on others' actions for oversight)." },
            { label: "Export", detail: "All roles — but each export logged with user_id + purpose for audit trail. Some tenants restrict export to risk_head / owner." },
          ],
        },
      ],
    },
    {
      title: "7. Settings (/nbfc/settings) — Tenant Configuration",
      sections: [
        {
          heading: "Tenant info (read-only)",
          rows: [
            { label: "Fields shown", detail: "Slug · Display Name · Contact Email · AUM (₹) · Active Loans." },
          ],
        },
        {
          heading: "Users (RBAC)",
          rows: [
            { label: "List", detail: "Current members with roles (owner, nbfc_operator, risk_head, nbfc_manager, finance)." },
            { label: "Invite", detail: "Email input + role dropdown + Send Invite → POST /api/nbfc/users.", mono: true },
            { label: "Remove", detail: "Per-member delete button (disabled for self) → DELETE /api/nbfc/users/{userId}.", mono: true },
            { label: "Role capabilities", detail: "owner (full) · nbfc_operator (read-only) · risk_head (approves dual-approval, flag for recovery) · nbfc_manager (approves single-approval) · finance (settlements / financials)." },
          ],
        },
        {
          heading: "Notification preferences (per-user)",
          rows: [
            { label: "Toggles", detail: "Email on risk alert · SMS on high-severity · WhatsApp reminders · Weekly digest." },
            { label: "Persistence", detail: "Saved to nbfc_users.notification_prefs (jsonb).", mono: true },
            { label: "Endpoint", detail: "PATCH /api/nbfc/users/notification-prefs { prefs }.", mono: true },
          ],
        },
        {
          heading: "Risk-rule thresholds (read-only)",
          rows: [
            { label: "Table", detail: "rule_key (e.g. cds_low_mid_threshold, cds_mid_high_threshold, max_loan_amount) · Current Value + unit · Updated timestamp.", mono: true },
            { label: "Note", detail: "Edits go through iTarang admin with dual-approval gate. Link: \"Edit (admin) →\" /admin/nbfc/risk-rules." },
          ],
        },
        {
          heading: "Key Workflows",
          rows: [
            { bullet: "W1.", label: "Onboard a New Team Member", detail: "Owner opens /nbfc/settings → Users section → clicks Invite User → modal opens → types email \"rajesh@dealer.com\" + role=nbfc_manager → Send Invite → POST /api/nbfc/users → invite email sent with accept-link → once accepted, rajesh appears in Users list. Owner confirms default notification prefs (in-app + email for action approvals)." },
            { bullet: "W2.", label: "Adjust Notification Preferences (self-service)", detail: "Manager logs in → Settings → Notification Preferences → sees toggles (In-app ✓, SMS ✓, Email ✓, Action approvals ✓, Risk alerts ✓, Auction updates ✓). Unchecks SMS (too noisy) → clicks Save → PATCH /api/nbfc/users/notification-prefs → henceforth no SMS notifications." },
            { bullet: "W3.", label: "Remove a Departing User", detail: "Risk Head leaves team → Owner opens Settings → Users list → finds old_risk_head@tenant.com → clicks Remove → confirmation modal \"Removing this user will revoke their access to all dashboards and disable their API keys\" → confirms → DELETE /api/nbfc/users/[user_id] → row soft-deleted (or hard-deleted per retention policy) → session invalidated → access lost immediately." },
            { bullet: "W4.", label: "Review Risk Thresholds", detail: "New risk analyst opens Settings → Risk-Rule Thresholds shows CDS low-mid 40 / CDS mid-high 70 / SOH refurbishable min 70% / Max DPD for field visit 60. Owner wants CDS mid-high → 75. Clicks \"Edit (admin) →\" → routed to /admin/nbfc/risk-rules (admin portal, admin role required). Admin updates threshold → next risk evaluation uses new 75." },
          ],
        },
        {
          heading: "Permissions",
          rows: [
            { label: "View Settings", detail: "All NBFC roles." },
            { label: "Invite / Remove Users", detail: "owner ONLY." },
            { label: "Edit Notification Preferences", detail: "All roles — self-service (each user manages their own)." },
            { label: "Edit Risk Rules", detail: "owner + admin (via /admin/nbfc/risk-rules with dual-approval; not editable from this page)." },
          ],
        },
      ],
    },
  ],
};

// ============================================================================
// COVER SHEET
// ============================================================================

function renderCover(sheet: ExcelJS.Worksheet, compartments: Compartment[]) {
  setupSheet(sheet);
  drawCompartmentTitle(sheet, "iTarang — 3-Month Work Report", COLOR.cover);

  // Author / date row
  sheet.getRow(3).height = 22;
  sheet.mergeCells("A3:D3");
  const meta = sheet.getCell("A3");
  meta.value = `Author: Aniket   ·   Period: February — May 2026   ·   Generated: ${stamp()}`;
  meta.font = { name: "Calibri", size: 11, italic: true, color: { argb: "FF" + COLOR.noteGray } };
  meta.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

  // Summary line
  sheet.mergeCells("A5:D5");
  const summary = sheet.getCell("A5");
  summary.value = "Five compartments documenting the features shipped, with sub-headers, fields, buttons, API endpoints, and status transitions for each.";
  summary.font = FONT_DETAIL;
  summary.alignment = { vertical: "middle", horizontal: "left", wrapText: true, indent: 1 };
  sheet.getRow(5).height = 30;

  // Table of contents heading
  drawSectionHeading(sheet, 7, "Table of Contents");

  let row = 8;
  for (let i = 0; i < compartments.length; i++) {
    const c = compartments[i];
    const r = sheet.getRow(row);
    r.getCell("A").value = `${i + 1}.`;
    r.getCell("A").font = FONT_BULLET;
    r.getCell("A").alignment = { vertical: "middle", horizontal: "center" };

    r.getCell("B").value = {
      text: c.tabTitle,
      hyperlink: `#'${c.tabTitle}'!A1`,
      tooltip: `Open ${c.tabTitle} tab`,
    } as ExcelJS.CellHyperlinkValue;
    r.getCell("B").font = { name: "Calibri", size: 11, bold: true, color: { argb: "FF" + COLOR.deepBlue }, underline: true };
    r.getCell("B").alignment = { vertical: "middle", horizontal: "left" };

    r.getCell("C").value = c.titleText.replace(/^\d+\.\s+/, "");
    r.getCell("C").font = FONT_DETAIL;
    r.getCell("C").alignment = { vertical: "middle", horizontal: "left", wrapText: true };

    r.getCell("D").value = `${c.subHeaders.length} sub-header${c.subHeaders.length === 1 ? "" : "s"}`;
    r.getCell("D").font = FONT_NOTE;
    r.getCell("D").alignment = { vertical: "middle", horizontal: "left" };

    sheet.getRow(row).height = 22;
    row += 1;
  }

  // Notes section
  row += 2;
  drawSectionHeading(sheet, row, "Notes");
  row += 1;
  const notes = [
    "Content is sourced from the actual codebase implementation — file paths, field names, buttons, API endpoints, and status transitions reflect the code as of the generation date.",
    "Intellicar Dashboard was requested but no `intellicar` files exist in the repo, so it has been omitted from this report.",
    "Admin Dashboard → NBFC Navbar → Onboard NBFC is a pointer to the dedicated NBFC Onboarding tab (full 6-step flow) to avoid duplication.",
    "Endpoints and table names are rendered in Consolas for clarity.",
  ];
  for (const n of notes) {
    drawDetailRow(sheet, row, { bullet: "•", label: "", detail: n });
    row += 1;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const compartments: Compartment[] = [
    DEALER_ONBOARDING,
    ADMIN_DASHBOARD,
    DEALER_DASHBOARD,
    NBFC_ONBOARDING,
    NBFC_DASHBOARD,
  ];

  const wb = new ExcelJS.Workbook();
  wb.creator = "scripts/generate-work-report.ts";
  wb.created = new Date();
  wb.title = "iTarang — 3-Month Work Report";

  const coverSheet = wb.addWorksheet("Cover", {
    properties: { tabColor: { argb: "FF" + COLOR.cover } },
  });
  renderCover(coverSheet, compartments);

  for (const c of compartments) {
    const sheet = wb.addWorksheet(c.tabTitle, {
      properties: { tabColor: { argb: "FF" + c.color } },
    });
    renderCompartment(sheet, c);
  }

  const filename = `Itarang_Work_Report_3_Months_${stamp()}.xlsx`;
  const outPath = path.resolve(process.cwd(), filename);
  await wb.xlsx.writeFile(outPath);

  console.log(`[report:work] wrote ${outPath}`);
  console.log(`[report:work]   ${compartments.length} compartment sheets + cover`);
}

main().catch((err) => {
  console.error("[report:work] failed:", err);
  process.exit(1);
});
