// Build a module-wise status report (.xlsx) for TL review.
//
//   npm:  node scripts/build-module-status-report.mjs
//   out:  docs/module-status-report.xlsx
//
// One sheet per module: AI Dialer, Scraping, KYC Admin Review, Sales Insight.
// Columns: Feature | Status | Timeline | Reason.
// Status defaults to "Done" (override before sharing if any are WIP). Timeline
// values are derived from `git log --diff-filter=A` of the primary file(s) per
// feature (see plans/fizzy-jumping-thunder.md for the methodology).

import ExcelJS from "exceljs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, "..", "docs", "module-status-report.xlsx");

const STATUS_VALUES = ["Done", "In Progress", "Pending", "Blocked"];

const STATUS_FILL = {
    Done:          "FFE6F4EA",
    "In Progress": "FFFFF4CE",
    Pending:       "FFF1F3F4",
    Blocked:       "FFFCE8E6",
};

const HEADER_FILL = "FF1A1A1A";
const HEADER_TEXT = "FFFFFFFF";

const MODULES = [
    {
        sheet: "AI Dialer",
        features: [
            { feature: "Manual on-demand calling from lead page", status: "Done", timeline: "Mar 2026", reason: "" },
            { feature: "Scheduled / cron-driven outbound campaigns (1-min cron)", status: "Done", timeline: "Mar 2026", reason: "" },
            { feature: "Multi-provider voice support (Bolna + ElevenLabs)", status: "Done", timeline: "May 2026", reason: "" },
            { feature: "Region-wise campaign grouping & auto-naming", status: "Done", timeline: "May 2026", reason: "" },
            { feature: "Bilingual voice (Hindi / English / Hinglish)", status: "Done", timeline: "Mar 2026", reason: "" },
            { feature: "Per-call deduplication guard (one call per lead per day)", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "Stalled-call auto-timeout (>4 min)", status: "Done", timeline: "May 2026", reason: "" },
            { feature: "AI transcript analysis + intent score (0–100)", status: "Done", timeline: "Mar 2026", reason: "" },
            { feature: "Intent-based lead classification (hot / warm / cold / disqualified)", status: "Done", timeline: "Mar 2026", reason: "" },
            { feature: "Callback-time parsing & auto-reschedule (Hindi/English)", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "Per-call cost tracking (LLM / TTS / STT / telephony)", status: "Done", timeline: "May 2026", reason: "" },
            { feature: "Global AI Caller kill-switch (admin toggle)", status: "Done", timeline: "May 2026", reason: "" },
        ],
    },
    {
        sheet: "Scraping",
        features: [
            { feature: "Google Places source integration", status: "Done", timeline: "Mar 2026", reason: "" },
            { feature: "Apify Google Places crawler source", status: "Done", timeline: "Mar 2026", reason: "" },
            { feature: "Firecrawl website enrichment", status: "Done", timeline: "Mar 2026", reason: "" },
            { feature: "AI-generated query variations (Gemini, 15 variants)", status: "Done", timeline: "Mar 2026", reason: "" },
            { feature: "Region / state → city auto-expansion", status: "Done", timeline: "Mar 2026", reason: "" },
            { feature: "Chunked pipeline via QStash (parallel chunks)", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "Phone / name normalization + spam filter", status: "Done", timeline: "Mar 2026", reason: "" },
            { feature: "Duplicate detection (name + address)", status: "Done", timeline: "Mar 2026", reason: "" },
            { feature: "Live progress dashboard (per-chunk status)", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "Run cancellation mid-execution", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "Two-sheet Excel export per run (Total + Saved)", status: "Done", timeline: "May 2026", reason: "" },
        ],
    },
    {
        sheet: "KYC Admin Review",
        features: [
            { feature: "Pending KYC queue with SLA + status filters", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "Per-document review cards (Aadhaar / PAN / Bank / RC / CIBIL)", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "Decentro verification (PAN / Bank / RC)", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "DigiLocker Aadhaar flow (initiate / resend OTP / status)", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "CIBIL score + full report pull", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "OCR extraction (Decentro for PAN/Aadhaar, Tesseract for Bank/RC)", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "DigiO e-signature consent verify + signed-PDF fetch", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "Co-borrower KYC sub-flow (PAN / Bank / RC / Aadhaar / CIBIL)", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "Request additional docs / request co-borrower actions", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "Final decision (Approved / Rejected / Dealer action required)", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "KYC data audit log (OCR vs API vs manual source)", status: "Done", timeline: "Apr 2026", reason: "" },
            { feature: "Lead → Dealer conversion on approval", status: "Done", timeline: "Apr 2026", reason: "" },
        ],
    },
    {
        sheet: "Sales Insight",
        features: [
            { feature: "Converted-leads unified funnel (AI Dialer + B2B)", status: "Done", timeline: "May 2026", reason: "" },
            { feature: "KPI cards (Total / MTD / Avg Intent / Conversion %)", status: "Done", timeline: "May 2026", reason: "" },
            { feature: "Date range + region + dealer + name/phone filters", status: "Done", timeline: "May 2026", reason: "" },
            { feature: "CSV export (full filtered set, up to 50k rows)", status: "Done", timeline: "May 2026", reason: "" },
            { feature: "Cross-source deduplication by phone with 'also_in' attribution", status: "Done", timeline: "May 2026", reason: "" },
            { feature: "Leads Info page (admin oversight of every lead)", status: "Done", timeline: "May 2026", reason: "" },
            { feature: "In-place lead reassignment drawer", status: "Done", timeline: "May 2026", reason: "" },
            { feature: "ASM visit lifecycle (scheduled / visited / postponed / no-show)", status: "Done", timeline: "May 2026", reason: "" },
            { feature: "Visit outcome capture (productive / uninterested / scheduling issue / etc.)", status: "Done", timeline: "May 2026", reason: "" },
            { feature: "Per-lead drawer with intent score + source drill-down", status: "Done", timeline: "May 2026", reason: "" },
        ],
    },
];

function styleHeader(row) {
    row.eachCell((cell) => {
        cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: HEADER_FILL },
        };
        cell.font = { bold: true, color: { argb: HEADER_TEXT }, size: 11 };
        cell.alignment = { vertical: "middle", horizontal: "center" };
        cell.border = {
            top:    { style: "thin", color: { argb: "FF000000" } },
            bottom: { style: "thin", color: { argb: "FF000000" } },
            left:   { style: "thin", color: { argb: "FF000000" } },
            right:  { style: "thin", color: { argb: "FF000000" } },
        };
    });
    row.height = 28;
}

function styleDataRow(row, status) {
    const fillArgb = STATUS_FILL[status] ?? "FFFFFFFF";
    row.eachCell((cell, colNumber) => {
        cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: fillArgb },
        };
        cell.font = { size: 11, color: { argb: "FF202124" } };
        cell.alignment = {
            vertical: "middle",
            horizontal: colNumber === 1 || colNumber === 4 ? "left" : "center",
            wrapText: true,
        };
        cell.border = {
            top:    { style: "thin", color: { argb: "FFCCCCCC" } },
            bottom: { style: "thin", color: { argb: "FFCCCCCC" } },
            left:   { style: "thin", color: { argb: "FFCCCCCC" } },
            right:  { style: "thin", color: { argb: "FFCCCCCC" } },
        };
    });
    row.height = 26;
}

function buildSheet(wb, mod) {
    const ws = wb.addWorksheet(mod.sheet, {
        views: [{ state: "frozen", ySplit: 1 }],
    });

    ws.columns = [
        { header: "Feature",  key: "feature",  width: 60 },
        { header: "Status",   key: "status",   width: 16 },
        { header: "Timeline", key: "timeline", width: 18 },
        { header: "Reason",   key: "reason",   width: 60 },
    ];

    styleHeader(ws.getRow(1));

    for (const f of mod.features) {
        const row = ws.addRow({
            feature: f.feature,
            status: f.status,
            timeline: f.timeline,
            reason: f.reason,
        });
        styleDataRow(row, f.status);
    }

    const lastRow = mod.features.length + 1;
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 4 } };

    // Status dropdown on data rows (column B).
    for (let r = 2; r <= lastRow; r += 1) {
        ws.getCell(r, 2).dataValidation = {
            type: "list",
            allowBlank: false,
            formulae: [`"${STATUS_VALUES.join(",")}"`],
            showErrorMessage: true,
            errorTitle: "Invalid status",
            error: `Status must be one of: ${STATUS_VALUES.join(", ")}`,
        };
    }
}

async function main() {
    const wb = new ExcelJS.Workbook();
    wb.creator = "Itarang Technologies";
    wb.created = new Date();

    for (const mod of MODULES) buildSheet(wb, mod);

    await wb.xlsx.writeFile(OUT_PATH);
    console.log(`wrote ${OUT_PATH}`);
    console.log(`sheets: ${MODULES.map((m) => `${m.sheet} (${m.features.length})`).join(", ")}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
