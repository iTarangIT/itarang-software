/**
 * Generates docs/iTarang-Database-Schema-Documentation.docx
 * from the Drizzle schema in src/lib/db/schema.ts.
 *
 * Run: npx tsx scripts/generate-db-schema-doc.ts
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

import * as schema from "../src/lib/db/schema";

// ---------------- Flow groups ----------------

type FlowGroup = {
  title: string;
  intro: string;
  tables: Array<{ name: string; export: keyof typeof schema; purpose: string }>;
  diagram: string; // file in docs/diagrams/
};

const FLOWS: FlowGroup[] = [
  {
    title: "1. Dealer Onboarding Flow",
    intro:
      "Captures the dealer's onboarding lifecycle: application creation, document upload, " +
      "admin verification, correction rounds, e-Sign agreement, and final activation of the dealer record. " +
      "An approved application produces a row in `dealers` (soft FK back to the application).",
    diagram: "01-dealer-onboarding.png",
    tables: [
      { name: "users", export: "users", purpose: "All platform users (admin, dealer, sales staff). Referenced as actor on most other tables." },
      { name: "dealer_onboarding_applications", export: "dealerOnboardingApplications", purpose: "In-flight onboarding workflow (draft → submitted → approved/rejected) with e-Sign agreement state." },
      { name: "dealer_onboarding_documents", export: "dealerOnboardingDocuments", purpose: "Dealer-uploaded onboarding documents (GST, PAN, bank proof, board resolution) with API verification results." },
      { name: "dealer_correction_rounds", export: "dealerCorrectionRounds", purpose: "Each iteration of admin → dealer correction requests (token-protected, time-bounded)." },
      { name: "dealer_correction_items", export: "dealerCorrectionItems", purpose: "Granular before/after diff for each requested field or document inside a correction round." },
      { name: "dealer_agreement_signers", export: "dealerAgreementSigners", purpose: "e-Sign signers per dealer agreement (dealer principal, Itarang signatories) with provider state." },
      { name: "dealer_agreement_events", export: "dealerAgreementEvents", purpose: "Provider webhook event log for the agreement lifecycle (initiated, signed, failed, stamped)." },
      { name: "admin_verification_queue", export: "adminVerificationQueue", purpose: "Admin task queue used to route onboarding and KYC verification work (priority, SLA, assignee)." },
      { name: "dealers", export: "dealers", purpose: "Master dealer account record created on application approval (legal + banking, finance flag)." },
    ],
  },
  {
    title: "2. Lead Creation, KYC, Co-borrower & Consent Flow",
    intro:
      "Lifecycle of a customer lead from dealer-portal creation through KYC verification, co-borrower capture, " +
      "supplementary document requests, and e-Sign consent. `kyc_verification_metadata` (one row per lead) " +
      "is the aggregate state the admin verification queue keys off.",
    diagram: "02-lead-kyc.png",
    tables: [
      { name: "leads", export: "leads", purpose: "Core lead record — owner contact, workflow step, KYC status, payment method, dealer scope." },
      { name: "personal_details", export: "personalDetails", purpose: "Borrower's personal & financial data (OCR-populated, with confidence scores)." },
      { name: "lead_documents", export: "leadDocuments", purpose: "Generic document storage for a lead (legacy + miscellaneous uploads)." },
      { name: "lead_assignments", export: "leadAssignments", purpose: "Tracks lead owner and current actor (AI agent / SM) for workflow routing." },
      { name: "kyc_documents", export: "kycDocuments", purpose: "KYC document uploads (Aadhaar, PAN, address) with OCR + API verification results." },
      { name: "kyc_verifications", export: "kycVerifications", purpose: "API verification attempts (Aadhaar, PAN, DigiLocker) with match scores and admin overrides." },
      { name: "kyc_verification_metadata", export: "kycVerificationMetadata", purpose: "One-row-per-lead aggregate KYC state (coupon, consent, final decision)." },
      { name: "kyc_data_audit", export: "kycDataAudit", purpose: "Audit trail for manual KYC field corrections entered by admin." },
      { name: "co_borrowers", export: "coBorrowers", purpose: "Co-borrower / guarantor details (spouse, parent, co-applicant) with KYC + consent state." },
      { name: "co_borrower_documents", export: "coBorrowerDocuments", purpose: "Co-borrower's uploaded KYC documents with OCR data." },
      { name: "consent_records", export: "consentRecords", purpose: "e-Signature consent tracking (loan consent, data consent) with provider integration." },
      { name: "other_document_requests", export: "otherDocumentRequests", purpose: "Admin-requested supplementary documents (Step 3) with upload-token + verification." },
      { name: "audit_logs", export: "auditLogs", purpose: "Master audit trail for all entity mutations across flows (polymorphic entity_type / entity_id)." },
      { name: "dealer_leads", export: "dealerLeads", purpose: "Scraper-produced dealer prospect records (separate from CRM `leads` until promoted)." },
    ],
  },
  {
    title: "3. Product Selection (Step 4) & Coupon Distribution",
    intro:
      "Step 4 captures the dealer's product configuration as a frozen snapshot (`product_selections`) with " +
      "complete pricing breakdown. Master tables (`product_master_batteries`, `_chargers`, `_paraphernalia`) " +
      "are the authoritative BRD-compliant catalog. Coupons attach to a lead at checkout and have an immutable audit log.",
    diagram: "03-product-coupon.png",
    tables: [
      { name: "product_selections", export: "productSelections", purpose: "Step-4 snapshot — battery/charger serials, paraphernalia lines, GST breakdown, admin decision." },
      { name: "products", export: "products", purpose: "Legacy product catalog (being superseded by `product_master_*` tables)." },
      { name: "product_categories", export: "productCategories", purpose: "Top-level product taxonomy (3-wheeler, 4-wheeler, etc)." },
      { name: "product_master_batteries", export: "productMasterBatteries", purpose: "BRD-compliant authoritative battery master (model, voltage, capacity, compatibility, warranty)." },
      { name: "product_master_chargers", export: "productMasterChargers", purpose: "BRD-compliant charger master (output V/A, charging protocol, compatible batteries)." },
      { name: "product_master_paraphernalia", export: "productMasterParaphernalia", purpose: "BRD-compliant accessories master (cables, harness variants, qty limits)." },
      { name: "coupon_batches", export: "couponBatches", purpose: "Batch creation of promo coupon codes per dealer (prefix, quantity, expiry, value)." },
      { name: "coupon_codes", export: "couponCodes", purpose: "Individual coupon codes with reservation / redemption state." },
      { name: "coupon_audit_log", export: "couponAuditLog", purpose: "Immutable audit trail of every coupon state change (created, reserved, used, revoked, expired)." },
    ],
  },
  {
    title: "4. Inventory Lifecycle (Upload, Single Item, Transfer, Write-off, Dispatch)",
    intro:
      "Inventory moves through statuses `available → reserved → dispatched → sold` (plus `written_off`). Every " +
      "transition appends to `inventory_events`. Bulk uploads write to `inventory_upload_reports`. Inter-dealer " +
      "movement uses `inventory_transfers`. Write-offs go through `inventory_write_offs` (with optional dual approval).",
    diagram: "04-inventory.png",
    tables: [
      { name: "inventory", export: "inventory", purpose: "Physical inventory record with full lifecycle state (serial, status, PDI, dispatch, sold timestamps)." },
      { name: "inventory_events", export: "inventoryEvents", purpose: "Append-only event stream of every inventory status mutation." },
      { name: "inventory_transfers", export: "inventoryTransfers", purpose: "Inter-dealer transfers (pending_acknowledgement → completed / cancelled)." },
      { name: "inventory_upload_reports", export: "inventoryUploadReports", purpose: "Audit log of bulk inventory uploads (total/inserted/skipped rows, error JSON)." },
      { name: "inventory_write_offs", export: "inventoryWriteOffs", purpose: "Write-off records with reason, value, and (when required) second approver." },
    ],
  },
  {
    title: "5. Loan / Finance Flow (Application → Sanction → Disbursal → Repayment)",
    intro:
      "Finance path runs in parallel with product selection. `loan_applications` and `loan_details` capture the " +
      "early-stage finance ask. After Step-4 admin sanction, a `loan_sanction` is created (links to the " +
      "`product_selection`). Disbursal opens a `loan_file`, against which `loan_payments` are recorded.",
    diagram: "05-loan-finance.png",
    tables: [
      { name: "loan_applications", export: "loanApplications", purpose: "Loan origination workflow (draft → submitted → approved → disbursed); NBFC routing + facilitation-fee state." },
      { name: "loan_details", export: "loanDetails", purpose: "Loan product details captured at application time (amount, tenure, EMI, financier)." },
      { name: "loan_sanctions", export: "loanSanctions", purpose: "Admin-sanctioned loans post Step-4 product selection; NBFC linkage; dealer approval; recovery flags." },
      { name: "loan_files", export: "loanFiles", purpose: "Full post-approval loan file — disbursal status, EMI schedule, total paid, overdue tracking, closure." },
      { name: "loan_payments", export: "loanPayments", purpose: "Individual EMI / payment records per loan file." },
    ],
  },
];

// ---------------- Column rendering helpers ----------------

function describeColumnType(col: any): string {
  const ct = String(col.columnType ?? "").replace(/^Pg/, "");
  const parts: string[] = [ct];
  if (col.length !== undefined && col.length !== null) parts[0] = `${ct}(${col.length})`;
  if (col.precision !== undefined && col.precision !== null) {
    const scale = col.scale !== undefined && col.scale !== null ? `,${col.scale}` : "";
    parts[0] = `${ct}(${col.precision}${scale})`;
  }
  if (Array.isArray(col.enumValues) && col.enumValues.length > 0) {
    parts[0] = `${ct}<${col.enumValues.slice(0, 3).join("|")}${col.enumValues.length > 3 ? "…" : ""}>`;
  }
  return parts[0];
}

function describeDefault(col: any): string {
  if (!col.hasDefault) return "";
  if (col.defaultFn) return "fn()";
  const d = col.default;
  if (d === undefined || d === null) return "(default)";
  if (typeof d === "object") {
    // SQL expression
    const qc = (d as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(qc)) return "sql expression";
    return "(default)";
  }
  return String(d);
}

function columnFlags(col: any): string {
  const flags: string[] = [];
  if (col.primary) flags.push("PK");
  if (col.isUnique) flags.push("UK");
  if (!col.notNull && !col.primary) flags.push("NULL");
  if (col.notNull && !col.primary) flags.push("NOT NULL");
  return flags.join(" / ");
}

// ---------------- Docx helpers ----------------

const BORDER = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
const TABLE_BORDERS = {
  top: BORDER,
  bottom: BORDER,
  left: BORDER,
  right: BORDER,
  insideHorizontal: BORDER,
  insideVertical: BORDER,
};

function p(text: string, opts: { bold?: boolean; italics?: boolean; size?: number; spacingAfter?: number } = {}): Paragraph {
  return new Paragraph({
    spacing: { after: opts.spacingAfter ?? 120 },
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        italics: opts.italics,
        size: opts.size,
      }),
    ],
  });
}

function heading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]): Paragraph {
  return new Paragraph({
    heading: level,
    spacing: { before: 240, after: 160 },
    children: [new TextRun({ text, bold: true })],
  });
}

function code(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    children: [new TextRun({ text, font: "Consolas", size: 18 })],
  });
}

function tableCell(text: string, opts: { bold?: boolean; width?: number; shading?: string; mono?: boolean } = {}): TableCell {
  return new TableCell({
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    shading: opts.shading ? { fill: opts.shading } : undefined,
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: text || "—",
            bold: opts.bold,
            font: opts.mono ? "Consolas" : undefined,
            size: opts.mono ? 18 : 20,
          }),
        ],
      }),
    ],
  });
}

function buildColumnsTable(tableExport: PgTable): Table {
  const cfg = getTableConfig(tableExport);
  const cols = cfg.columns;

  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      tableCell("Column", { bold: true, width: 28, shading: "E8EEF7" }),
      tableCell("Type", { bold: true, width: 22, shading: "E8EEF7" }),
      tableCell("Flags", { bold: true, width: 18, shading: "E8EEF7" }),
      tableCell("Default", { bold: true, width: 16, shading: "E8EEF7" }),
      tableCell("FK / Notes", { bold: true, width: 16, shading: "E8EEF7" }),
    ],
  });

  // Build a quick column-name → FK-target map
  const fkByCol = new Map<string, string>();
  for (const fk of cfg.foreignKeys) {
    const ref = fk.reference();
    for (let i = 0; i < ref.columns.length; i++) {
      const localCol = ref.columns[i].name;
      const foreignTable = (ref.foreignTable as any)?.[Symbol.for("drizzle:Name")] ?? "?";
      const foreignCol = ref.foreignColumns[i]?.name ?? "?";
      fkByCol.set(localCol, `→ ${foreignTable}.${foreignCol}`);
    }
  }

  const rows = cols.map((c: any) => {
    return new TableRow({
      children: [
        tableCell(c.name, { mono: true }),
        tableCell(describeColumnType(c), { mono: true }),
        tableCell(columnFlags(c), { mono: true }),
        tableCell(describeDefault(c), { mono: true }),
        tableCell(fkByCol.get(c.name) ?? "", { mono: true }),
      ],
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TABLE_BORDERS,
    rows: [headerRow, ...rows],
  });
}

function buildRelationships(tableExport: PgTable): Paragraph[] {
  const cfg = getTableConfig(tableExport);
  const out: Paragraph[] = [];

  out.push(heading("Foreign keys", HeadingLevel.HEADING_4));
  if (cfg.foreignKeys.length === 0) {
    out.push(p("None.", { italics: true }));
  } else {
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      const local = ref.columns.map((c: any) => c.name).join(", ");
      const foreignTable = (ref.foreignTable as any)?.[Symbol.for("drizzle:Name")] ?? "?";
      const foreign = ref.foreignColumns.map((c: any) => c.name).join(", ");
      const onDel = fk.onDelete ? ` ON DELETE ${fk.onDelete}` : "";
      const onUpd = fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : "";
      out.push(code(`  • ${local}  →  ${foreignTable}(${foreign})${onDel}${onUpd}`));
    }
  }

  out.push(heading("Indexes & unique constraints", HeadingLevel.HEADING_4));
  const idx = cfg.indexes ?? [];
  const uniq = cfg.uniqueConstraints ?? [];
  if (idx.length === 0 && uniq.length === 0) {
    out.push(p("None declared in schema.", { italics: true }));
  } else {
    for (const ix of idx) {
      const cols = (ix.config?.columns ?? []).map((c: any) => c?.name ?? "?").join(", ");
      const uniqMark = ix.config?.unique ? " UNIQUE" : "";
      out.push(code(`  • idx ${ix.config?.name ?? "(unnamed)"}${uniqMark}: (${cols})`));
    }
    for (const u of uniq) {
      const cols = (u.columns ?? []).map((c: any) => c?.name ?? "?").join(", ");
      out.push(code(`  • unique ${u.name ?? "(unnamed)"}: (${cols})`));
    }
  }

  return out;
}

// ---------------- Mermaid → PNG (best effort) ----------------

async function renderMermaidDiagrams(diagramsDir: string): Promise<void> {
  let puppeteer: any;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    console.warn("[diagrams] puppeteer not available — skipping PNG rendering.");
    return;
  }

  const files = (await fs.readdir(diagramsDir)).filter((f) => f.endsWith(".mmd"));
  if (files.length === 0) return;

  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
  } catch (e) {
    console.warn(`[diagrams] failed to launch browser: ${(e as Error).message}`);
    return;
  }

  try {
    for (const file of files) {
      const mmd = await fs.readFile(path.join(diagramsDir, file), "utf8");
      const out = path.join(diagramsDir, file.replace(/\.mmd$/, ".png"));

      const page = await browser.newPage();
      await page.setViewport({ width: 2000, height: 1400, deviceScaleFactor: 2 });
      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>body{margin:0;background:#fff;font-family:Inter,Arial}#out{padding:24px}</style></head>
<body>
<div id="out" class="mermaid">${mmd.replace(/</g, "&lt;")}</div>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: false, theme: 'default', er: { layoutDirection: 'LR' }, securityLevel: 'loose' });
  try {
    const { svg } = await mermaid.render('rendered', \`${mmd.replace(/`/g, "\\`").replace(/\$/g, "\\$")}\`);
    document.getElementById('out').innerHTML = svg;
    window.__done = true;
  } catch (err) {
    document.body.innerText = 'ERR: ' + err.message;
    window.__done = 'error';
  }
</script>
</body></html>`;
      try {
        await page.setContent(html, { waitUntil: "networkidle0", timeout: 180000 });
        await page.waitForFunction("window.__done === true", { timeout: 180000 });
        const el = await page.$("svg");
        if (el) {
          const buf = await el.screenshot({ type: "png", omitBackground: false });
          await fs.writeFile(out, buf);
          console.log(`[diagrams] rendered ${file} → ${path.basename(out)}`);
        } else {
          console.warn(`[diagrams] no <svg> rendered for ${file}`);
        }
      } catch (e) {
        console.warn(`[diagrams] failed ${file}: ${(e as Error).message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}

// ---------------- Document assembly ----------------

async function buildDocument(diagramsDir: string): Promise<Document> {
  const today = new Date().toISOString().slice(0, 10);
  const children: (Paragraph | Table)[] = [];

  // Cover
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 1200, after: 360 },
      children: [new TextRun({ text: "iTarang CRM", bold: true, size: 56 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [new TextRun({ text: "Database Schema & Process-Flow Documentation", bold: true, size: 36 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: `AWS RDS · database-1 · generated ${today}`, italics: true, size: 22 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 480 },
      children: [new TextRun({ text: "42 tables across 5 business flows", size: 22 })],
    }),
    new Paragraph({
      spacing: { before: 240, after: 120 },
      children: [
        new TextRun({
          text:
            "This document is generated from the live Drizzle schema in src/lib/db/schema.ts. " +
            "Every column, foreign key, index, and unique constraint reflects what is declared in code. " +
            "Five business flows are documented in order; each flow has an entity-relationship diagram " +
            "followed by per-table column reference and relationship listings.",
        }),
      ],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  );

  // Table of contents (manual — list of flows)
  children.push(heading("Contents", HeadingLevel.HEADING_1));
  for (const f of FLOWS) {
    children.push(p(`• ${f.title} — ${f.tables.length} tables`));
  }
  children.push(p("• Cross-flow narrative (end-to-end sale lifecycle)"));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // Sections
  for (const flow of FLOWS) {
    children.push(heading(flow.title, HeadingLevel.HEADING_1));
    children.push(p(flow.intro));

    // Diagram
    const pngPath = path.join(diagramsDir, flow.diagram);
    try {
      const png = await fs.readFile(pngPath);
      children.push(heading("Entity-relationship diagram", HeadingLevel.HEADING_3));
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 80, after: 80 },
          children: [
            new ImageRun({
              data: png,
              transformation: { width: 620, height: 380 },
              type: "png",
            } as any),
          ],
        }),
      );
      const mmdName = flow.diagram.replace(/\.png$/, ".mmd");
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: `Source: docs/diagrams/${mmdName}`, italics: true, size: 18 })],
        }),
      );
    } catch {
      children.push(p(`[Diagram unavailable — render docs/diagrams/${flow.diagram} to embed it.]`, { italics: true }));
    }

    children.push(heading("Tables in this flow", HeadingLevel.HEADING_3));
    for (const t of flow.tables) {
      children.push(p(`• ${t.name} — ${t.purpose}`));
    }

    // Per-table sections
    for (const t of flow.tables) {
      const tableExport = (schema as any)[t.export] as PgTable | undefined;
      if (!tableExport) {
        children.push(heading(t.name, HeadingLevel.HEADING_2));
        children.push(p(`Missing schema export "${t.export}".`, { italics: true }));
        continue;
      }
      children.push(heading(t.name, HeadingLevel.HEADING_2));
      children.push(p(t.purpose, { italics: true }));
      children.push(buildColumnsTable(tableExport));
      for (const para of buildRelationships(tableExport)) {
        children.push(para);
      }
    }

    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // Cross-flow narrative
  children.push(heading("Cross-flow narrative — end-to-end sale lifecycle", HeadingLevel.HEADING_1));
  const narrative: Array<[string, string]> = [
    [
      "Onboarding",
      "A prospective dealer creates a row in dealer_onboarding_applications. Documents land in " +
        "dealer_onboarding_documents. The admin verification queue picks up the application; if corrections " +
        "are needed, a dealer_correction_round is created with one dealer_correction_item per requested field/document. " +
        "The dealer e-signs through dealer_agreement_signers; provider webhooks land in dealer_agreement_events. " +
        "On final approval the dealer record is created (dealers.onboarding_status='active'); the activated row " +
        "soft-references the application via application_id.",
    ],
    [
      "Dealer login → lead",
      "An active dealer creates a lead via /api/leads/create. A row is written to leads " +
        "(dealer_id scope, workflow_step=1, uploader_id = current user). Initial KYC fields land in " +
        "personal_details. Lead ownership / handoff is tracked in lead_assignments.",
    ],
    [
      "KYC + co-borrower",
      "Document uploads write to kyc_documents (doc_for='customer' or 'co_borrower'). Each API call to a KYC provider " +
        "(Decentro, DigiLocker) is recorded in kyc_verifications, with a match_score and optional admin_action override. " +
        "The aggregate lifecycle state (coupon, consent, final_decision) is upserted into kyc_verification_metadata " +
        "(one row per lead). Manual admin field corrections are audited in kyc_data_audit. If a co-borrower is " +
        "required, co_borrowers + co_borrower_documents are populated; consent for both parties is tracked in " +
        "consent_records (DigiO/eSign provider state, signed PDF URL). Supplementary admin-requested documents " +
        "use other_document_requests with a one-time upload_token. audit_logs receives a row for every mutation.",
    ],
    [
      "Product selection (Step 4)",
      "The dealer chooses battery + charger + paraphernalia from the product_master_* catalog. A single " +
        "product_selections row is written per lead (CASCADE on lead delete), capturing serials, GST breakdown, " +
        "and admin_decision. A coupon (if applied) is resolved against coupon_codes (code lookup + reservation), " +
        "with every state change appended to coupon_audit_log.",
    ],
    [
      "OTP + dispatch (Step 5)",
      "Step-5 OTP confirms the customer and flips inventory.status from 'reserved' to 'dispatched' " +
        "(inventory.dispatch_date set, inventory_events row appended). On final sale confirmation status moves " +
        "to 'sold' (inventory.sold_at set). Inter-dealer movements use inventory_transfers; bulk uploads write " +
        "to inventory_upload_reports. Damaged stock is removed via inventory_write_offs.",
    ],
    [
      "Cash vs finance fork",
      "Cash sale: confirm-cash-sale endpoint marks product_selections.payment_mode='cash' and triggers sale " +
        "finalization. Finance sale: loan_applications captures the loan ask; on Step-4 admin sanction a " +
        "loan_sanction is created (links to product_selection); disbursal opens a loan_file; each EMI/payment is " +
        "logged in loan_payments; NBFC scope flows via loan_sanctions.nbfc_id.",
    ],
  ];
  for (const [head, body] of narrative) {
    children.push(heading(head, HeadingLevel.HEADING_3));
    children.push(p(body));
  }

  return new Document({
    creator: "iTarang db-schema generator",
    title: "iTarang Database Schema & Flow Documentation",
    description: "Auto-generated from src/lib/db/schema.ts",
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 22 } },
      },
    },
    sections: [{ children }],
  });
}

// ---------------- main ----------------

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, "..");
  const diagramsDir = path.join(repoRoot, "docs", "diagrams");
  const outPath = path.join(repoRoot, "docs", "iTarang-Database-Schema-Documentation.docx");

  console.log("Step 1/3 — rendering Mermaid diagrams (best effort)…");
  await renderMermaidDiagrams(diagramsDir);

  console.log("Step 2/3 — building Word document…");
  const doc = await buildDocument(diagramsDir);

  console.log("Step 3/3 — writing .docx…");
  const buf = await Packer.toBuffer(doc);
  await fs.writeFile(outPath, buf);

  console.log(`✓ Wrote ${outPath} (${(buf.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
