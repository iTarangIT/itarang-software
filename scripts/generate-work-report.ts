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
          heading: "Dealer Verification (/admin/dealer-verification)",
          rows: [
            { label: "KPI cards", detail: "Total · Pending · Approved · Rejected counts." },
            { label: "Status tabs / Payment tabs", detail: "Pending (default) · All · Approved · Rejected. Finance · Cash." },
            { label: "Search", detail: "By dealer name, company name, or GSTIN." },
            { label: "Duplicate flag badges", detail: "Branch (shares GSTIN with another dealer → approved as additional location) · Duplicate (same GSTIN + PAN + address → approval blocked) · PAN Mismatch (GSTIN registered under a different PAN → verify before approving)." },
            { label: "Row fields", detail: "Dealer Code · Company Name · Status · Submitted Date · GST Number · Finance Enabled · Sales Manager Name · Duplicate Flag." },
          ],
        },
        {
          heading: "Dealer Verification Detail — Company / Docs / Actions panels",
          rows: [
            { label: "Left panel — Company & Contact", detail: "Company tiles (Name, Type, GST, PAN, Address) · Primary contact derived from ownership · Bank account info (Bank, Account No, IFSC, Beneficiary, Account Type)." },
            { label: "Center panel — Compliance Documents", detail: "Clickable preview tiles: GST Cert, Company PAN, ITR, Bank Statement, Cheques, Photo, Udyam Cert. Each shows file name, upload date, verification status (Verified / Pending / Rejected with reason)." },
            { label: "Right panel — Actions", detail: "Approve · Reject (dialog captures reason) · Download Profile (PDF export) · Request Correction (modal flags specific fields / documents for re-submission) · Re-upload (after rejection)." },
          ],
        },
        {
          heading: "Dealer Verification Detail — Digio Agreement (Finance enabled)",
          rows: [
            { label: "Status card", detail: "Status badge · Request ID · Document ID · Signing URL." },
            { label: "Signer cards", detail: "Dealer Signatory (Name, Designation, Email, Phone, Signing Method) · Financier Signatory · iTarang Signatories 1 & 2." },
            { label: "Signing order flow chart", detail: "Visual sequence — Dealer → iTarang 1 → iTarang 2." },
            { label: "Initiate Digio Agreement", detail: "Triggers Digio request when no agreement yet exists for the dealer." },
            { label: "Refresh Agreement Status", detail: "Syncs status from the latest Digio callback." },
            { label: "Approve Agreement", detail: "Marks the agreement as accepted by iTarang admin." },
            { label: "Reject Agreement", detail: "Captures rejection reason; agreement returns to dealer for re-initiation." },
            { label: "Request Correction", detail: "Flags specific signer or metadata fields for the dealer to correct before re-signing." },
            { label: "Sales Manager info card", detail: "Name, Email, Mobile, Age (captured in Step 4 or Step 5 of dealer onboarding)." },
          ],
        },
      ],
    },
    {
      title: "C. Inventory",
      sections: [
        {
          heading: "Product Master (/admin/product-master) — Batteries tab",
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
  titleText: "3.  Dealer Dashboard — Sales Navbar",
  color: COLOR.teal,
  subHeaders: [
    {
      title: "Sales Navbar — built in the last 3 months",
      sections: [
        {
          heading: "1. Dashboard Home",
          rows: [
            { label: "Header", detail: "Greeting \"Hello [dealer_name]\" + account status badge. If pending, an approval modal mounts on first load (\"Congratulations\" card with company name, dealer ID, activation date)." },
            { label: "KPI cards (8)", detail: "Total Leads · Converted Leads · Conversion Rate · Commission · Inventory Count · Total Payments · Loan Count · Rewards." },
            { label: "Recent Leads panel", detail: "Last 5–10 hot + qualified leads — columns: Customer · Interest dot (hot/warm/cold) · Status badge · Date. Click routes to the appropriate detail page (KYC or Product Selection by payment method)." },
            { label: "Quick Action cards", detail: "+ New Lead → /dealer-portal/leads/new · View All Leads → /dealer-portal/leads · My Drafts → /dealer-portal/leads/drafts (count badge if any) · Inventory → /dealer-portal/inventory." },
            { label: "Approval gate", detail: "If the dealer is not approved, dashboard renders a locked state with \"Contact iTarang support\"." },
          ],
        },
        {
          heading: "2. Lead Management — list page (/dealer-portal/leads)",
          rows: [
            { label: "Filters", detail: "Search (name, phone, 500 ms debounce) · Status (All / New / Contacted / Qualified) · Type (All / Hot / Warm / Cold)." },
            { label: "Columns", detail: "Customer (name + phone) · Status badge · Interest (colored dot + label) · Loan Amount (₹) · Created (MM/DD/YYYY) · Actions (View / Edit / Delete on hover)." },
            { label: "View Details (conditional routing)", detail: "Hot + finance → /leads/{id}/kyc · Hot + cash → /leads/{id}/product-selection · Warm/Cold → /leads/new?id={id} (resume Step 1)." },
            { label: "Edit (pencil)", detail: "Modal: Full Name, Phone, Interest Level, Payment Method (cash / dealer_finance / other_finance). PATCH /api/dealer/leads/{id} → auto-refresh.", mono: true },
            { label: "Delete (trash)", detail: "Confirmation modal warns all associated KYC / docs / consent records are permanently removed. DELETE /api/dealer/leads/{id}.", mono: true },
          ],
        },
        {
          heading: "2a. Lead Creation Wizard — step by step (/dealer-portal/leads/new)",
          rows: [
            { bullet: "1.", label: "Customer Info", detail: "Full Name (letters only, capitalize each word) · Phone (10 digits, auto-strip non-digits) · Father/Husband Name · DOB (date picker)." },
            { bullet: "2.", label: "Address", detail: "Current Address (textarea) · Permanent Address (textarea) · \"Same as current\" checkbox auto-fills permanent." },
            { bullet: "3.", label: "Vehicle / Asset", detail: "Vehicle Ownership (dropdown) · Vehicle RC (auto-uppercase) · Vehicle Owner Name / Phone · Category (3W / 2W / 4W / Inverter / Solar / Other)." },
            { bullet: "4.", label: "Interest & Payment", detail: "Interest Level (hot / warm / cold) → determines downstream routing. Payment Method (cash / dealer_finance / other_finance) → determines product flow." },
            { bullet: "5.", label: "Product Selection", detail: "ProductSelector component — primary product (battery model) · additional products (chargers, paraphernalia) via multi-add drawer. Compatible options auto-filter based on category + primary selection." },
            { label: "Save Draft", detail: "POST /api/leads/create with { leadId, formData, draftId } → toast \"Draft saved\".", mono: true },
            { label: "Continue", detail: "Validates required fields → routes to KYC (hot + finance) or product-selection (cash)." },
            { label: "Auto-save", detail: "Background POST every 2 minutes while editing." },
            { label: "Resume logic", detail: "GET /api/leads/create?initializeDraft=true on load → if a draft exists, prompts \"Resume draft?\". \"Start fresh\" clears draft. Edit mode (?id=LEAD-…) loads the lead via GET /api/dealer/leads/{id} and bypasses the draft system.", mono: true },
          ],
        },
        {
          heading: "3. My Drafts (/dealer-portal/leads/drafts)",
          rows: [
            { label: "Purpose", detail: "Save-points for KYC forms in progress (Steps 1–4) — auto-saved every 2 minutes." },
            { label: "Filters", detail: "Search (name / phone, 500 ms debounce) · Progress bucket (All / <25% / 25–75% / >75%)." },
            { label: "Columns", detail: "Customer (name + phone or \"Unnamed customer\" + lead ID) · Progress bar (% + docs uploaded X/Y, consent pending/verified) · Step (1–5) · Consent badge (Pending / In progress / Signed) · Last Saved (relative time)." },
            { label: "Resume action", detail: "Routes to /leads/new?id={leadId}." },
            { label: "Clear draft", detail: "DELETE /api/dealer/leads/drafts/{leadId} — only clears the draft cache; the lead itself is kept and KYC can be restarted anytime.", mono: true },
          ],
        },
        {
          heading: "4. Inventory — dealer view (/dealer-portal/inventory)",
          rows: [
            { label: "Incoming Transfers panel", detail: "Blue info box at top showing pending_acknowledgement transfers to this dealer (ID, # serials, date, reason). \"Acknowledge\" button → POST /api/dealer/inventory/acknowledge-transfer { transferId }. After ack the units become available.", mono: true },
            { label: "KPI cards (6)", detail: "Total Units · Available · Reserved · Sold · Low Stock · Out of Stock." },
            { label: "Filters", detail: "Search (product / SKU) · Category (Battery / Charger / Paraphernalia) · Status (clickable KPI cards: All / Low Stock / Out of Stock)." },
            { label: "Columns", detail: "Product · Category · Warehouse · Available · Reserved (yellow badge if >0) · Sold · Unit Price (₹) · Stock Value (₹, available × unit_price) · Received (DD-MMM-YYYY) · Status." },
            { label: "Export", detail: "Generates CSV with active filters, date-stamped filename." },
            { label: "Reserve / Dispatch / Sell", detail: "In-row or modal actions move the unit through the lifecycle." },
            { label: "Status transitions", detail: "available → reserved (on lead qualification) → dispatched (on shipment) → sold (on delivery confirmation). available → written_off (on damage/loss).", mono: true },
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
