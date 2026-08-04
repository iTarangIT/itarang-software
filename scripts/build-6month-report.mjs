// Builds the 6-month work report by MERGING two existing workbooks and adding the
// work neither of them covers. Run with:
//   node scripts/build-6month-report.mjs
//
// WHY A SCRIPT AND NOT A HAND-EDITED FILE. The two source workbooks together hold
// ~1,300 authored rows with a consistent style system. Re-typing them would lose
// content and drift the styling; hand-editing in Excel makes the result
// unreproducible. This script is the record of how the merged file was produced,
// so it can be re-run when the next period's work is added.
//
// THE SOURCES ARE NEVER WRITTEN TO. The 3-month workbook is loaded and used as the
// BASE — that way its nine sheets keep their original cell styling without being
// re-created — and the result is written to a new path. Verified with jszip that
// neither source contains images, charts or drawings, so the exceljs
// read -> write round-trip is lossless here.
//
// ACCURACY RULES BAKED IN (see the plan): a migration that is not applied is not
// reported as "Completed"; the peakAmp battery-buyback module is excluded because
// it is another developer's work (note that E-185..E-188 is a TWICE-TAKEN number —
// the risk-engine family here is ours, the buyback family on main is not);
// Navprakruti is labelled a design deliverable because it has no code in this repo;
// and the 1-3 Aug work is labelled In Progress because it is uncommitted.

import ExcelJS from "exceljs";
import path from "node:path";
import os from "node:os";

const DESKTOP = path.join(os.homedir(), "OneDrive", "Desktop");
const SRC_3M = path.join(DESKTOP, "Itarang_Work_Report_3_Months_2026-05-25(1)_with_WhatsApp.xlsx");
const SRC_UPD = path.join(DESKTOP, "Itarang_Work_Report_Update_2026-07-31.xlsx");
const OUT = path.join(os.homedir(), "Downloads", "Itarang_Work_Report_6_Months_2026-08-03.xlsx");

// ── Style system ──────────────────────────────────────────────────────────────
// Measured from the existing workbooks so new sheets are indistinguishable from
// carried-over ones. Do not "improve" these values in isolation — the whole point
// is that all 26 sheets read as one document.
const NAVY = "FF1F3A5F";
const WIDTHS = [4, 44, 82, 22, 15];

// Status chip colours. Green/amber/grey/red rather than green-only, because this
// report has to distinguish shipped from in-flight from documentation from gap —
// a report where everything is green is not a report.
const CHIPS = {
    done: { fg: "FF166534", bg: "FFE8F5E9" },
    wip: { fg: "FF92400E", bg: "FFFEF3C7" },
    info: { fg: "FF374151", bg: "FFF3F4F6" },
    gap: { fg: "FF991B1B", bg: "FFFEE2E2" },
};
// Words that mean "not finished" or "not code" get the non-green chip.
const chipFor = (s) => {
    const t = String(s || "").toLowerCase();
    if (/gap|not applied|unapplied|missing|never fires|bug/.test(t)) return CHIPS.gap;
    if (/progress|wip|pending|partial|to confirm|open/.test(t)) return CHIPS.wip;
    if (/doc|reference|design|note|scope|testing|qa|ops|schema|rbac/.test(t)) return CHIPS.info;
    return CHIPS.done;
};

function styleSheet(ws, widths = WIDTHS) {
    ws.columns = widths.map((w) => ({ width: w }));
    ws.views = [{ state: "frozen", ySplit: 1 }];
}

function title(ws, text) {
    const r = ws.addRow([text]);
    r.height = 25.95;
    ws.mergeCells(`A${r.number}:D${r.number}`);
    r.getCell(1).font = { bold: true, size: 16, color: { argb: "FFFFFFFF" }, name: "Calibri" };
    r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    r.getCell(1).alignment = { vertical: "middle" };
    r.getCell(5).value = "STATUS";
    r.getCell(5).font = { bold: true, size: 11, color: { argb: "FFFFFFFF" }, name: "Calibri" };
    r.getCell(5).fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    r.getCell(5).alignment = { horizontal: "center", vertical: "middle" };
    return r;
}

function section(ws, text, status) {
    ws.addRow([]);
    const r = ws.addRow([text]);
    r.height = 22.05;
    ws.mergeCells(`A${r.number}:D${r.number}`);
    r.getCell(1).font = { bold: true, size: 12, color: { argb: "FFFFFFFF" }, name: "Calibri" };
    r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    r.getCell(1).alignment = { vertical: "middle" };
    if (status) chip(r.getCell(5), status);
    return r;
}

function sub(ws, text) {
    const r = ws.addRow([text]);
    r.getCell(1).font = { bold: true, size: 10, name: "Calibri" };
    return r;
}

function chip(cell, status) {
    const c = chipFor(status);
    cell.value = status;
    cell.font = { bold: true, size: 10, color: { argb: c.fg }, name: "Calibri" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.bg } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
}

function item(ws, titleText, desc, status) {
    const r = ws.addRow(["•", titleText, desc]);
    r.getCell(1).font = { size: 10, color: { argb: "FF6B7280" }, name: "Calibri" };
    r.getCell(1).alignment = { horizontal: "center", vertical: "top" };
    r.getCell(2).font = { bold: true, size: 10, name: "Calibri" };
    r.getCell(2).alignment = { vertical: "top", wrapText: true };
    r.getCell(3).font = { size: 10, name: "Calibri" };
    r.getCell(3).alignment = { vertical: "top", wrapText: true };
    if (status) chip(r.getCell(5), status);
    return r;
}

function note(ws, text) {
    const r = ws.addRow([null, null, text]);
    r.getCell(3).font = { size: 9, italic: true, color: { argb: "FF6B7280" }, name: "Calibri" };
    r.getCell(3).alignment = { vertical: "top", wrapText: true };
    return r;
}

// ── Cross-workbook sheet copy ─────────────────────────────────────────────────
// exceljs has no API for copying a worksheet between workbooks, so this walks
// every cell and carries value + the four style facets that the source actually
// uses. Also copies column widths, row heights and merge ranges — a merge is what
// makes the navy header bars span A:D, so dropping them would visibly break every
// carried-over sheet.
function copySheet(srcWs, destWb, newName) {
    const ws = destWb.addWorksheet(newName);
    ws.columns = (srcWs.columns || []).map((c) => ({ width: c.width }));
    ws.views = srcWs.views;

    srcWs.eachRow({ includeEmpty: true }, (srcRow, rowNumber) => {
        const row = ws.getRow(rowNumber);
        if (srcRow.height) row.height = srcRow.height;
        srcRow.eachCell({ includeEmpty: true }, (srcCell, colNumber) => {
            const cell = row.getCell(colNumber);
            if (srcCell.value !== null && srcCell.value !== undefined) cell.value = srcCell.value;
            if (srcCell.font) cell.font = srcCell.font;
            if (srcCell.fill && srcCell.fill.type) cell.fill = srcCell.fill;
            if (srcCell.alignment) cell.alignment = srcCell.alignment;
            if (srcCell.border) cell.border = srcCell.border;
            if (srcCell.numFmt) cell.numFmt = srcCell.numFmt;
        });
        row.commit();
    });

    // _merges is keyed by top-left address; the value carries the full range.
    for (const key of Object.keys(srcWs._merges || {})) {
        const m = srcWs._merges[key];
        const range = m && m.model ? m.model : m;
        try {
            ws.mergeCells(
                range.top ? `${cellRef(range.left, range.top)}:${cellRef(range.right, range.bottom)}` : key,
            );
        } catch {
            /* already merged / degenerate range — safe to skip */
        }
    }
    return ws;
}

const colLetter = (n) => {
    let s = "";
    while (n > 0) {
        const m = (n - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        n = Math.floor((n - m - 1) / 26);
    }
    return s;
};
const cellRef = (c, r) => `${colLetter(c)}${r}`;

// ── Content: Part C sheets ────────────────────────────────────────────────────

function sheetEmiTracker(wb) {
    const ws = wb.addWorksheet("7. NBFC EMI Tracker");
    styleSheet(ws);
    title(ws, "7.  NBFC Dashboard — EMI Tracker");

    section(ws, "A. What it is", "Completed");
    sub(ws, "One screen for the state of every active loan");
    item(ws, "Portfolio-wide EMI view", "For an NBFC partner: every active loan with next due date, last paid, repayment progress, DPD, E-NACH mandate status, next auto-debit date and the financier label — kept current by nightly crons with no manual entry.", "Completed");
    item(ws, "Why it was needed", "Collections were tracked in a spreadsheet outside the system. The portfolio, battery-risk and lead pages all read repayment data, so a spreadsheet that nobody imported meant every one of those screens was quietly stale.", "Context");
    item(ws, "Where it lives", "/nbfc/emi-tracker · src/app/(dashboard)/nbfc/emi-tracker/ with _components/EmiTrackerClient.tsx, EmiBulkUploadModal.tsx, RecordPaymentModal.tsx.", "Reference");

    section(ws, "B. Bulk upload of the collections spreadsheet", "Completed");
    sub(ws, "The hard part: the source sheet is not a table");
    item(ws, "Repeating headers", "The operations sheet is WIDE and repeats the same header — “EMI Collect Date” appears seven times, once per installment. Header-name lookup cannot work, so collection pairs are resolved POSITIONALLY; only genuinely single-value columns are matched by normalised alias.", "Decision");
    item(ws, "Two date formats", "Cells arrive as Excel serial numbers or as dd/mm/yyyy text. Both are accepted, and every parse is round-trip checked so an impossible date (30 Feb, 31 Apr) is reported as a blocking cell issue rather than silently becoming a real date.", "Decision");
    item(ws, "One validator, two callers", "The validation module is pure — no DB, no IO — so the same code gives the instant client-side preview and the authoritative server-side re-validation. A preview that disagreed with the commit would be worse than no preview.", "Decision");
    item(ws, "Template download", "The expected shape is downloadable from the UI, so ops are not reverse-engineering the parser.", "Completed");
    note(ws, "src/lib/nbfc/emi-tracker/bulkUpload.ts · src/app/api/nbfc/emi-tracker/{bulk-upload,template}/route.ts");

    section(ws, "C. What a commit actually writes", "Completed");
    sub(ws, "Two layers, and one rule that protects the ledger");
    item(ws, "Display layer", "Presentation-only corrections land in nbfc_emi_tracker_overrides, so what ops see can be fixed without touching the loan ledger.", "E-181");
    item(ws, "Canonical layer", "Paid slots are also flipped in the canonical emi_schedules table to Paid / Paid-Late — this is what makes the numbers real rather than a display veneer.", "E-029");
    item(ws, "An upload can never un-pay", "Blank slots in the spreadsheet are NEVER written. An upload can only ever record MORE payment, never retract one, so a partially-filled sheet cannot wipe a recorded payment.", "Decision");
    item(ws, "Amounts are not mutated", "The installment DUE amount and the canonical lead data are never changed by an import — only payment state is.", "Decision");

    section(ws, "D. The recompute cascade", "Completed");
    sub(ws, "Why an import triggers scoring work");
    item(ws, "CDS and PCI read emi_schedules", "The Credit Default Score and the Payment Consistency Index are computed from the schedule. Writing payments without recomputing would leave the portfolio, battery and lead pages showing a score that contradicts the payments just imported.", "Context");
    item(ws, "Best-effort recompute after commit", "DPD aging, then CDS, then PCI are recomputed after the commit succeeds. Best-effort on purpose: the payments are already written and correct, so a recompute failure must not fail the import.", "Decision");
    item(ws, "Nightly crons keep it current", "runEmiAging / recomputeLoanDpd / compute-cds / compute-pci run on the VPS crontab; the import is the manual entry point into the same pipeline.", "Completed");

    section(ws, "E. Records with no matching loan", "Completed");
    item(ws, "Standalone tracker rows", "A force-imported row that matches no loan in the system becomes a display-only “standalone” entry rather than being rejected — loan_application_id was made nullable with a partial unique on (tenant, lower(vehicleno)). Ops can see the collection even when the loan was never created here.", "E-183");
    item(ws, "Manual cash payment", "A payment can be recorded against a single installment from the UI for cash collections that never touch E-NACH.", "Completed");
    item(ws, "CSV export", "The whole table exports to CSV for reconciliation against the ops spreadsheet.", "Completed");

    section(ws, "F. Migrations behind this sheet", "Mixed");
    item(ws, "E-181 / E-182 / E-183", "Tracker overrides · financier label · standalone rows. Applied on production and sandbox.", "Applied");
    item(ws, "E-171 / E-172 / E-173", "Tracker columns · payment attempts · partial payments. NOT APPLIED in any environment — the features that depend on them are not live until they are run.", "Not applied");
    item(ws, "E-029_emi_schedules", "The canonical schedule table. Predates this reporting period and is also unapplied — worth resolving before relying on tracker output.", "Not applied");
    note(ws, "Dates: 22 Jun 2026 (page + E-171/172/173) · 7 Jul 2026 (bulk upload, overrides, financier, standalone rows)");
    return ws;
}

function sheetLoanProduct(wb) {
    const ws = wb.addWorksheet("8. Loan Product Flow");
    styleSheet(ws);
    title(ws, "8.  Loan Product Flow — configuration to sanction");

    section(ws, "A. Scope of this sheet — read first", "Scope note");
    item(ws, "Most of this flow predates the period", "The 6-step NBFC onboarding wizard, the CEO mid-flow verification gate and the loan_sanctions schema were built BEFORE 26 May 2026 and are documented in the months 1–3 sheets “NBFC Onboarding” and “NBFC Dashboard”. They are not re-claimed here.", "Scope note");
    item(ws, "What this sheet covers", "Only the incremental loan-product work done between 26 May and 3 Aug 2026, plus the path a sanction takes once a product is chosen — so the reviewer can see the whole flow without double-counting.", "Scope note");

    section(ws, "B. How the flow works end to end", "Reference");
    sub(ws, "Admin configures → dealer selects → admin sanctions → NBFC services");
    item(ws, "Product configuration", "Per NBFC: amount bands, tenure, scheme highlights, active locations and the CIBIL / minimum-credit-score requirement. Admin surfaces at /admin/loan-products and /admin/nbfc/[nbfcId]/loan-products.", "Reference");
    item(ws, "Dealer product selection (Step 4)", "The dealer's Step 4 surfaces the products whose band and location match the case in front of them.", "Reference");
    item(ws, "Sanction", "An admin sanction writes loan_sanctions, which is the row the NBFC portal's servicing and EMI layer then reads — this is the join between origination and servicing.", "Reference");
    note(ws, "src/app/api/admin/nbfc/loan-products/[productId]/route.ts · src/app/api/admin/loan-sanctions/validate-band/route.ts · src/app/api/admin/lead/[id]/sanction-loan/route.ts · SanctionPanel.tsx");

    section(ws, "C. Changes made in this period", "Completed");
    item(ws, "More than one loan product on the selection page", "The product-selection page could only ever show a single product; it now shows every eligible one, which is what makes a genuine multi-NBFC choice possible. (7 Jun 2026)", "Completed");
    item(ws, "NBFC name removed from the loan product", "The partner's name was being shown on the product itself; removed so the dealer chooses on terms, not on brand. (4–5 Jun 2026)", "Change");
    item(ws, "NBFC Active button fixed", "The activation control did not reliably move an NBFC to active; traced and fixed. (5 Jun 2026)", "Fix");
    item(ws, "Step-4 pre-sanction document bucket", "The dealer can attach up to 10 pre-sanction items in any format, with a server-side combine-to-PDF; a combined PDF counts as one item. Visible to both the NBFC dossier and the admin product review.", "E-208");
    item(ws, "Step 1 and Step 4 corrections", "Field and gating corrections from the sandbox testing rounds, including the access gate reading the final decision from the correct place.", "Fix");
    item(ws, "Welcome-mail URL on activation", "The NBFC activation credentials email pointed at the wrong host; fixed. (2 Jun 2026)", "Fix");

    section(ws, "D. Migrations", "Mixed");
    item(ws, "E-208_product_selections_pre_sanction_docs", "The Step-4 bucket. Applied on production and sandbox.", "Applied");
    item(ws, "No new loan-product migration this period", "E-113 / E-114 / E-115 (loan-product columns) and E-026 (loan_sanctions lifecycle) predate the period. E-113/114/115 remain unapplied — flagged rather than presented as shipped.", "Not applied");
    return ws;
}

function sheetLiveAttack(wb) {
    const ws = wb.addWorksheet("9. Live Attack Protection");
    styleSheet(ws);
    title(ws, "9.  Live Attack Protection — the auto-block layer (1 Aug)");

    section(ws, "A. What this adds beyond detection", "Completed");
    item(ws, "Detection alone was not protection", "Sheet 4 describes the detector: it recognises an attack payload, refuses that request and records it. But the attacker's NEXT request, with the payload rewritten to slip past the regex, was served normally. Recording an attacker is not stopping one.", "Context");
    item(ws, "Now the IP itself is banned", "Once an address has proven hostile, every subsequent request from it is refused for a period regardless of what it contains — so rewriting the payload no longer helps.", "New");
    note(ws, "src/lib/security/blocklist.ts · consumed by src/middleware.ts via checkBlocked / recordStrike / shouldEmitBlockEvent");

    section(ws, "B. What earns a strike", "Completed");
    item(ws, "Only high-confidence events", "A strike is recorded only for rules that already decided to BLOCK — SQL injection, XSS, path traversal, command injection, SSRF, LFI/RFI, NoSQL injection, CRLF, prototype pollution, XXE, sensitive-file probes, scanner user-agents, method abuse.", "Completed");
    item(ws, "Soft signals never ban anyone", "sensitive_unauth, open_redirect and a request flood from one NAT IP are logged, not struck. A dealer's whole office behind a single address is legitimately noisy and must not be bannable.", "Decision");
    item(ws, "Critical bans on the first hit", "A JNDI / Log4Shell payload bans immediately — that string has no innocent explanation, so waiting for a third strike only gives away time.", "Decision");

    section(ws, "C. How long the ban lasts", "Completed");
    item(ws, "Escalating, doubling, capped", "Threshold is 3 strikes in a 10-minute window (1 if critical). Ban length is base × 2^(previous bans), capped at 24 hours — so a returning offender is punished harder without any address being banned forever.", "Completed");
    item(ws, "Controls", "SECURITY_AUTO_BLOCK (set to 0 to disable), SECURITY_AUTO_BLOCK_STRIKES, SECURITY_BLOCK_ALLOWLIST. On by default once detection itself is enabled.", "Reference");

    section(ws, "D. The guard that matters most", "Completed");
    item(ws, "Only public addresses are ever banned", "If nginx stops setting X-Real-IP, every request resolves to the same loopback address — banning it would take the entire CRM offline for every user at once. isPublicIp() makes that outcome unreachable rather than unlikely.", "Decision");
    item(ws, "Trusted source-IP resolution", "nginx uses $proxy_add_x_forwarded_for, which APPENDS, so reading the FIRST X-Forwarded-For entry is attacker-controlled — it lets an attacker frame an arbitrary address and hide their own. The RIGHTMOST entry, x-real-ip and cf-connecting-ip are trusted instead.", "Fix");
    item(ws, "One row per ban, not per request", "A banned attacker hammering the app writes ONE ip_blocked event, not one per refused request — otherwise the audit trail becomes the denial of service.", "Decision");

    section(ws, "E. What gets recorded about an attacker", "Completed");
    item(ws, "Full profile, no schema change", "Source-IP provenance and the whole proxy chain, client fingerprint (browser / tool / scanner / bot), IP scope, geo as already set by the CDN with vendor provenance, and behavioural flags — all into the existing evidence jsonb.", "Completed");
    item(ws, "Would-if-succeeded impact", "Each event type carries an iTarang-specific impact statement: what it would have reached, the CRM risk, the assets at stake (lead and customer KYC — Aadhaar, PAN, bank; loan sanctions and EMI schedules; dealer and user accounts; the S3 document store; provider credentials) and the response.", "Completed");
    item(ws, "Visible on the IT dashboard", "The Live Attacks table and the per-IP profile drawer (30-day aggregate: events, blocked, first seen, last seen, types) at /it/security/live.", "Completed");

    section(ws, "F. Honest limits", "Reference");
    item(ws, "State is in-memory, per process", "The Edge runtime has no timers and no shared store, so bans live in a bounded in-process Map. A PM2 restart clears them, and under cluster mode each worker counts separately.", "Limitation");
    item(ws, "Not a DDoS defence", "This stops the single determined prober — the threat that actually reaches this app. Absorbing a distributed attack belongs upstream at nginx limit_req or Cloudflare and is deliberately not attempted here.", "Limitation");
    item(ws, "E-222 is comment-only", "The migration documents the ip_blocked event type and the evidence key taxonomy. It contains no DDL, so the feature works whether or not it has been run — which is why it is still unapplied everywhere.", "Not applied");

    section(ws, "G. How it was tested", "QA");
    item(ws, "Attack sandbox script", "scripts/attack-sandbox.sh runs 17 single-request payload attacks plus body and volumetric modes against a target. Every payload is deliberately harmless — they only need to MATCH the detector's rules, not exploit anything.", "QA");
    item(ws, "Event verification", "scripts/verify-security-events.mjs confirms rows land with the expected type, action and evidence.", "QA");
    return ws;
}

function sheetLeadsDedupe(wb) {
    const ws = wb.addWorksheet("10. Customer Leads & Dedupe");
    styleSheet(ws);
    title(ws, "10.  Customer Leads, Dedupe and the Lead Timeline");

    section(ws, "A. The problem: four answers to one question", "Context");
    item(ws, "Four implementations disagreed", "Every door into the prospect pool had its own duplicate check, and they gave different answers for the same lead. Whether a dealer was a duplicate depended on which screen you happened to use.", "Context");
    item(ws, "The strict one", "The bulk CSV wizard — normalised the phone and classified properly. This was the correct behaviour and became the model.", "Context");
    item(ws, "The lax ones", "/api/leads/import matched on phone only and skipped silently. /api/leads/check-duplicate was lax AND pointed at the wrong table entirely — the loan entity, not the prospect pool.", "Gap");
    item(ws, "The dangerous one", "POST /api/dealer-leads did NO normalisation at all — it stored the raw typed string. “98765 43210” and “+919876543210” became two different dealers, and such a row could never afterwards be matched by any importer.", "Gap");

    section(ws, "B. One engine, four outcomes", "In Progress");
    item(ws, "Every entry path now agrees", "Bulk wizard, /leads Import, the new single-lead modal, the AI-dialer upload and NeoDove inbound all resolve through one module.", "In Progress");
    item(ws, "Four canonical outcomes", "valid · reactivate · address_mismatch · duplicate_skip. An address_mismatch raises a merge request for a human rather than guessing.", "In Progress");
    item(ws, "Matching is on phone alone", "Phone is the only field reliably present on a scraped or imported lead. City is a tie-breaker, deliberately NOT part of the key — including it would let a typo in a city name create a duplicate dealer.", "Decision");
    item(ws, "Rules are testable in isolation", "The pure rules module has zero imports specifically so it can be unit-tested — importing the DB-backed module would pull in the database client, which throws at import time without a connection string and opens a real pool with one.", "Decision");
    note(ws, "src/lib/leads/dedupe.ts · src/lib/leads/dedupe-rules.ts · src/lib/leads/__tests__/");

    section(ws, "C. The duplicate-lead bug this exposed", "Gap");
    item(ws, "The lookup was an exact text match", "Duplicate detection ran WHERE phone IN (normalised). But the unique index on dealer_leads.phone is on the RAW text, so “8269342343” and “+918269342343” are two different keys and both get in. The check therefore missed every lead stored in the other format and reported “no duplicate”.", "Gap");
    item(ws, "Caught in a live round-trip", "A lead was pushed to NeoDove; NeoDove echoed the record back one second later; the check did not match it, and a second copy of the same dealer was created — with no shop name and no city. Every push was doing this.", "Gap");
    item(ws, "Fixed by matching on the last 10 digits", "Now compared on digits, oldest record winning, using the same idiom the lead detail page already uses to attribute calls.", "In Progress");
    item(ws, "15 phone numbers already have duplicates", "The fix stops new ones; it does not merge the existing pairs. Needs a business decision — merge into the oldest, or raise merge requests for review.", "Open");

    section(ws, "D. Central lead registry", "Applied");
    item(ws, "One row per capture, everywhere", "Every lead-like capture anywhere on the platform — customer, dealer, NBFC, web or WhatsApp — writes one row with name, phone and a link back to the source record, so “where did this person come from” is answerable in one query.", "E-179");
    item(ws, "Failure is swallowed on purpose", "A failed registry write must never break lead creation — the registry is an index, not the record.", "Decision");
    item(ws, "Channel on the lead", "source_channel distinguishes web from WhatsApp, which matters because the admin KYC gate normally hides documents until a coupon is consumed and WhatsApp has no coupon step.", "E-174");

    section(ws, "E. Lead capture and the timeline", "In Progress");
    item(ws, "Add Lead modal", "A single-lead capture form with a live duplicate check as the phone is typed, so the duplicate is caught before submission rather than after.", "In Progress");
    item(ws, "Activity timeline on the lead page", "/leads/[id] built its history only from AI-dialer call logs, so every human, WhatsApp and NeoDove touchpoint was being written and never rendered. The timeline now shows them.", "In Progress");
    item(ws, "External calls counted as calls", "Call History, Total Calls and Latest Status read only the dialer table, so a lead could show “No calls made yet” directly above a timeline entry describing a call. External call touchpoints are now a third source. Hand-off requests are excluded — asking for a call is not a call.", "In Progress");
    item(ws, "Customer email made optional", "Email is no longer mandatory on dealer-dashboard lead capture — many walk-in customers do not have one.", "Change");
    return ws;
}

function sheetNeodove(wb) {
    const ws = wb.addWorksheet("11. NeoDove Integration");
    styleSheet(ws);
    title(ws, "11.  NeoDove Telecalling Integration (1–3 Aug)");

    section(ws, "A. What it is and why", "In Progress");
    item(ws, "The two systems shared nothing", "The business runs telecalling in NeoDove, while the prospect pool, scraper, AI dialer and loan funnel live in the CRM. Leads were re-typed and call outcomes never came back.", "Context");
    item(ws, "A two-way sync", "The CRM pushes selected leads into a NeoDove campaign, and NeoDove's webhook returns dispositions, which are written to the lead's timeline as real calls with the telecaller's name.", "In Progress");
    note(ws, "src/lib/neodove/ · src/app/api/neodove/ · docs/neodove-contract.md");

    section(ws, "B. Three hard constraints — and what each forced", "Reference");
    item(ws, "No read API", "NeoDove cannot be queried at all. A dropped webhook is unrecoverable, so the sync-events table is a RECONCILIATION LEDGER, not a debug log — a CSV export diffed against it is the only way to find what was lost.", "Decision");
    item(ws, "No dial API", "Nothing the CRM sends can make a phone ring. So the per-lead action says “queued for” and never “calling” — an operator who reads “calling” and hears silence concludes the integration is broken.", "Decision");
    item(ws, "No assignee parameter", "A pushed lead arrives unassigned and no change on our side can alter that. Agents must be staffed on the campaign inside NeoDove's own UI. The CRM records who works a campaign as DESCRIPTIVE mirror data, and says so on every field.", "Decision");
    item(ws, "The endpoint URL is the credential", "NeoDove issues no API key or signing secret — possession of the campaign URL is write access. So the database stores the NAME of an environment variable, never the URL itself.", "Decision");

    section(ws, "C. What was built", "In Progress");
    item(ws, "Campaign push with dedupe", "Audience preview, single and batch push, with a unique index on (lead, campaign) so re-pushing a selection reports already-linked instead of double-sending.", "E-224");
    item(ws, "Inbound webhook", "Bearer-authenticated, fast-acknowledged, with two independent replay guards — the raw body is stored verbatim BEFORE parsing so an unrecognised payload is still captured.", "E-224");
    item(ws, "Campaign mirror", "Pipeline, managing user, agent list and lead-distribution setting recorded so a sales head can see who works a campaign without opening NeoDove.", "E-225");
    item(ws, "Call recording and agent attribution", "Recording URL and the external telecaller's name on the touchpoint. The agent's name is free text — they have no user row here, and inventing one would corrupt ownership attribution.", "E-226");
    item(ws, "Reconciliation", "A CSV export can be posted back to backfill touchpoints the webhook never delivered, with campaign drift reported.", "E-224");

    section(ws, "D. The payload discovery — and the seven corrections", "Fix");
    item(ws, "The parser was written against guesses", "NeoDove publishes no developer reference, no schema, no error codes; their API doc host 404s and there is no third-party connector to reverse-engineer. The inbound parser was therefore an educated guess.", "Context");
    item(ws, "The real payload was found in their own UI", "The Integrations screen prints a sample curl once a URL is entered. It invalidated SEVEN of the nine field mappings, and a live webhook then confirmed the shape.", "Fix");
    item(ws, "The worst one", "The event type is in event_name, which was not read — so every event fell through to the disposition default and a lead CREATED in NeoDove was routed to the disposition handler, matched nothing and was filed unresolved. The inbound-create half of the sync could never have worked.", "Fix");
    item(ws, "Timestamps", "time arrives as epoch milliseconds in a string, which parsed as an invalid date — leaving dedupe on a 60-second bucket, so a genuine second call to the same lead inside a minute was dropped as a replay.", "Fix");
    item(ws, "The readable disposition", "The screen showed “Disposition: 6” — NeoDove's internal status id. The readable label, the stage, the tag and the telecaller's typed reason are all separate fields that were not being read.", "Fix");
    item(ws, "Our own join key was ignored", "itarang_lead_id comes back nested inside a custom-properties array, not as a flat key, so the identifier the whole design rests on was unread and matching fell back to phone alone.", "Fix");
    item(ws, "Pinned by tests", "The real payload is now a fixture in the test suite, so changing the parser reports what it breaks.", "QA");

    section(ws, "E. Migrations and status", "In Progress");
    item(ws, "E-224 / E-225 / E-226", "Two-way sync tables · campaign mirror · call recording and priority-dial flag. Applied to db-1 (sandbox); NOT on production, where the Campaigns tab degrades to AI-dialer rows only, which is the intended behaviour.", "In Progress");
    item(ws, "Code not yet committed", "As of 3 Aug this work is in the working tree, not merged. Reported here for completeness, not as delivered.", "In Progress");

    section(ws, "F. Open items", "Open");
    item(ws, "Campaign staffing in NeoDove", "The campaign that receives pushed leads has no agents, so arriving leads show an empty assignee and cannot be worked. Blocked on NeoDove-side configuration; raised with them.", "Open");
    item(ws, "The lead_status code table", "Dispositions arrive as an opaque numeric code with no published mapping. Stored verbatim and deliberately not guessed into a call status.", "Open");
    item(ws, "Recording and agent on this trigger", "The fixed webhook payload carries neither. Only the Workflows sender, whose body is author-defined, could carry them — a known next step.", "Open");
    item(ws, "Priority dial removed", "A per-lead “Call now” hand-off was built and then removed on request; the flag was cleared and the UI taken out. The route and column remain inert.", "Change");
    return ws;
}

function sheetNavprakruti(wb) {
    const ws = wb.addWorksheet("12. Navprakruti Costing");
    styleSheet(ws);
    title(ws, "12.  Navprakruti — System Architecture and Costing");

    section(ws, "A. What this is — and what it is not", "Design deliverable");
    item(ws, "A design and costing deliverable", "This is architecture, scoping and commercial work produced for a prospective white-label deployment. It is NOT CRM code — nothing described here ships inside the iTarang CRM, and it is listed separately so the reviewer is not counting it as delivered software.", "Design deliverable");
    item(ws, "A separate build", "The proposed system is a white-label recycler-buyback platform on a different stack (Laravel) in its own repository — a fork of the buyback concept for an external party, not a module of this CRM.", "Scope note");
    item(ws, "Why it sits in this report", "It was a substantial piece of work in the period: the full system design, the cost model and the commercial plan were authored, revised across several versions, and used for a pricing decision.", "Scope note");

    section(ws, "B. Deliverables produced", "Completed");
    item(ws, "Full system design and architecture", "End-to-end system design covering the dealer and recycler sides, the flow between them and the platform architecture, written up as a browsable document.", "Completed");
    item(ws, "Business requirements document", "The recycler-buyback BRD, revised across three versions.", "Completed");
    item(ws, "Cost and build model", "A costed build model — modules, effort and phasing — iterated from v1 through v4.", "Completed");
    item(ws, "Cost options comparison", "A side-by-side comparison of build options at v5, which is the artefact the pricing decision was taken from.", "Completed");

    section(ws, "C. Commercial outcome", "Completed");
    item(ws, "Plan", "A one-time build price with a phased delivery timeline of roughly eleven weeks.", "Completed");
    item(ws, "Locked decisions", "Three pricing decisions were settled and locked during the costing rounds, which is what allowed v5 to be a comparison rather than another revision.", "Completed");

    section(ws, "D. Where the documents are", "Reference");
    item(ws, "System design", "NavPrak_Full_System_Design_and_Costing.html", "Reference");
    item(ws, "Cost models", "NavPrakruti_Cost_and_Build_Model.xlsx · iTarang-Recycler-Buyback-Costing-and-Plan.xlsx v1–v4 · iTarang-Recycler-Buyback-Cost-Options-Comparison-v5.xlsx", "Reference");
    item(ws, "BRD", "iTarang-Recycler-Buyback-BRD_NavPrak.docx (three revisions)", "Reference");
    note(ws, "These files live outside the CRM repository. Confirmed by exhaustive search that no Navprakruti code, migration, document or commit exists in the iTarang CRM codebase.");
    return ws;
}

// ── Content: the Changes master list ──────────────────────────────────────────
// Flat, one row per change, so this sheet is the index to the whole second half of
// the report. Deliberately includes fixes, removals and gaps, not only features.
const CHANGES = [
    // [date, area, what changed, migration, status]
    ["Late May", "NBFC file", "Acquire split into 5 stages: Verification, Offer, Winner, Agreement + E-NACH, Submit", "", "Completed"],
    ["Late May", "NBFC file", "Agreement documents made visible inside the NBFC dashboard; sandbox lead-loading drift repaired", "", "Fix"],
    ["29 May", "Agreements", "Production PDF rendering made reliable", "", "Fix"],
    ["30 May", "Ops", "System Chrome provisioned in the deploy so Initiate Agreement stops failing", "", "Fix"],
    ["1–2 Jun", "NBFC file", "Field Investigation built — form, coordinator email, submit visit", "", "Completed"],
    ["1–2 Jun", "NBFC file", "Passive Video KYC built; file errors and the stuck 'failed' status resolved", "", "Completed"],
    ["1 Jun", "Agreements", "NBFC signatory made optional where the partner does not counter-sign", "", "Change"],
    ["2 Jun", "Onboarding", "A dealer onboarding application is auto-created on lead conversion", "", "Completed"],
    ["2 Jun", "NBFC", "Activation welcome-mail URL fixed", "", "Fix"],
    ["3–5 Jun", "NBFC", "Testing round with the TL: Step 1 / Step 4 changes, submit route, activation button", "", "QA"],
    ["4–5 Jun", "Loan product", "NBFC name removed from the loan product", "", "Change"],
    ["5 Jun", "NBFC", "NBFC Active button logic fixed", "", "Fix"],
    ["7 Jun", "Loan product", "Product-selection page can show more than one loan product", "", "Completed"],
    ["7 Jun", "NBFC file", "E-NACH first pass; popups restyled to the system's own design language", "", "Completed"],
    ["10 Jun", "Onboarding", "New onboarding vs My Drafts chooser; draft step persisted so a wizard resumes where it stopped", "E-164", "Not applied"],
    ["11 Jun", "WhatsApp", "WhatsApp onboarding schema — sessions and message log", "E-167", "Not applied"],
    ["11 Jun", "Validation", "Initiate Agreement button made to work end to end", "", "Completed"],
    ["16–17 Jun", "WhatsApp", "Dealer onboarding bot flow plus the admin-side UI changes", "", "Completed"],
    ["16–17 Jun", "Validation", "Additional address on the verification queue; billing and dispatch address", "", "New"],
    ["16–17 Jun", "Validation", "Dealer validation list exports to Excel, with filters", "", "New"],
    ["22 Jun", "Mobile", "Dealer dashboard and WhatsApp screens made to work on a phone — frontend only", "", "Completed"],
    ["22 Jun", "EMI tracker", "NBFC EMI tracker page built", "E-171/172/173", "Not applied"],
    ["23 Jun", "Storage", "Dealer documents served without a session so tokenised links work for recipients who are not logged in", "", "Fix"],
    ["23 Jun", "Validation", "Approve failure traced to a signed-URL problem on object storage", "", "Fix"],
    ["24 Jun", "WhatsApp", "Post-approval dealer console and lead draft capture over WhatsApp", "E-170", "Not applied"],
    ["27–28 Jun", "WhatsApp", "New-lead creation working; PAN required for cash leads", "E-174", "Not applied"],
    ["29 Jun", "Onboarding", "Owner Aadhaar and the Aadhaar card unified; PAN card and company PAN unified — no longer asked twice", "", "Fix"],
    ["29 Jun", "Onboarding", "Aadhaar must be on file before e-sign, and the signing Aadhaar must match it", "E-175/E-176", "Completed"],
    ["29 Jun", "WhatsApp", "A mid-flow 'hi' no longer wipes onboarding progress", "", "Fix"],
    ["1–2 Jul", "WhatsApp", "Front door reworked — the bot asks what the person needs instead of assuming dealer onboarding", "", "Change"],
    ["2 Jul", "Calculator", "Dealer loan calculator on a verified deterministic engine with a config-versioned schema", "E-177", "Applied"],
    ["2 Jul", "Calculator", "OTP gate, WhatsApp delivery of results, admin console and dealer search history", "E-178", "Applied"],
    ["3 Jul", "WhatsApp", "Hindi and free-text understood at the front door via intent routing", "", "Completed"],
    ["3 Jul", "Leads", "Central lead registry — one row per capture across every type and channel", "E-179", "Applied"],
    ["3 Jul", "Validation", "Branch approvals made explicit; stale branch dealer-code reuse stopped", "", "Fix"],
    ["5 Jul", "KYC", "Aadhaar e-sign replaced by 6-digit OTP consent for customer, co-borrower and WhatsApp leads", "E-180", "Applied"],
    ["5 Jul", "Leads", "Self-onboarding lead classification removed; leads default to hot", "", "Change"],
    ["5 Jul", "Validation", "Direct Approve (test-only) button added — approves without the e-sign round trip, behind a second confirmation", "", "New"],
    ["7 Jul", "Email", "Outbound mail moved off raw SMTP to AgentMail", "", "Change"],
    ["7 Jul", "EMI tracker", "Bulk upload of the collections spreadsheet, display overrides, financier, standalone rows", "E-181/182/183", "Applied"],
    ["13 Jul", "Risk", "Risk engine design and the five hand-coded evaluators", "", "Completed"],
    ["14 Jul", "Risk", "Verdict source, run records, promotion gate, hypothesis-text-matches-code", "E-185–E-188", "Mixed"],
    ["15 Jul", "Risk", "Python risk sandbox containerised and deployed on the VPS with auth, an AST gate and a time cap", "", "Completed"],
    ["16 Jul", "Risk", "Risk alerting wired from card verdicts; sandbox prompt and graph tuning", "", "Completed"],
    ["18–19 Jul", "NBFC file", "Correction-request reject flow; Acquire working end to end; E-NACH mandate; dispatch", "", "Completed"],
    ["20 Jul", "Risk", "Risk cards opened to the admin dashboard, with per-NBFC card visibility as a strict allowlist", "E-199", "Applied"],
    ["22–23 Jul", "NBFC KYC", "Two-way document loop — NBFC to admin to dealer to customer and back; per-document NBFC verdicts", "E-200–E-210", "Mixed"],
    ["22–23 Jul", "NBFC KYC", "Step-4 pre-sanction document bucket, up to 10 items with server-side combine-to-PDF", "E-208", "Applied"],
    ["23 Jul", "Risk", "Card catalogue with authored Info panels explaining each card's logic and data sources", "", "Completed"],
    ["24 Jul", "Notifications", "Notification engine wired across every portal — one event, many audiences, per-role copy and links", "E-211", "Applied"],
    ["24 Jul", "Agreements", "Defect that let agreements render with blank detail fields closed", "", "Fix"],
    ["25 Jul", "Accounts", "Invite User — users can be invited rather than created by hand", "", "New"],
    ["25 Jul", "Accounts", "Forgot password — self-service reset owning our own token table so both password stores stay in sync", "E-212", "Applied"],
    ["25 Jul", "Accounts", "Change password — in-app modal with an emailed code, deliberately no current-password field", "E-213", "Applied"],
    ["25 Jul", "Accounts", "Profile page for every role", "", "New"],
    ["25 Jul", "NBFC", "NBFC-owned consent system removed on a business decision", "", "Removed"],
    ["25 Jul", "Validation", "Approve button repositioned on the review screen", "", "Change"],
    ["25 Jul", "Validation", "A dealer approved without finance can later be switched to finance-enabled and sign then", "", "New"],
    ["25 Jul", "Leads", "Battery IMEI captured; customer email made optional", "", "Change"],
    ["27 Jul", "WhatsApp", "Operator console — one internal number onboards many dealers, with handoff to the dealer", "E-214", "Applied"],
    ["27 Jul", "WhatsApp", "Admin WhatsApp Onboarding screen: Live conversations, Customer leads and Onboarding team tabs", "", "New"],
    ["27 Jul", "Validation", "Approve path fixed", "", "Fix"],
    ["28 Jul", "Notifications", "155-notification master catalogue produced for business sign-off", "", "Docs"],
    ["29 Jul", "Leads", "Meeting mode on a lead visit — splits WhatsApp meetings from doorstep visits for the CEO report", "E-220", "Applied"],
    ["29 Jul", "Leads", "Quote approval gate — issuing a quote to a dealer now needs CEO approval", "E-221", "Applied"],
    ["30 Jul", "Security", "Security scanner agent, live attack detection, AI resolution chat with auto-apply, resolution audit", "E-215–E-219", "Applied"],
    ["30 Jul", "IT", "IT dashboard — a new 'it' role with /it, /it/security, /it/security/live and history", "", "Completed"],
    ["30 Jul", "Docs", "Security end-to-end flow and agent function map written into the repo", "", "Docs"],
    ["31 Jul", "Security", "ip_blocked event type and the evidence key taxonomy documented", "E-222", "Not applied"],
    ["Jul", "Navprakruti", "Full system design, BRD, cost and build model v1–v4 and cost-options comparison v5", "", "Design deliverable"],
    ["1 Aug", "Security", "Live attack protection — repeat-offender IPs auto-banned with escalating duration", "", "Completed"],
    ["1 Aug", "Security", "Source-IP resolution fixed — the first X-Forwarded-For entry is attacker-controlled", "", "Fix"],
    ["1 Aug", "IT", "Live Attacks table and per-IP profile drawer on the IT dashboard", "", "Completed"],
    ["1 Aug", "NeoDove", "Two-way lead sync — campaign push, inbound webhook, reconciliation ledger", "E-224", "In Progress"],
    ["3 Aug", "NeoDove", "Campaign mirror — records who works a campaign inside NeoDove", "E-225", "In Progress"],
    ["3 Aug", "NeoDove", "Call recording URL and external agent name on the touchpoint", "E-226", "In Progress"],
    ["3 Aug", "NeoDove", "Webhook payload confirmed against NeoDove's own sample; seven of nine field mappings corrected", "", "Fix"],
    ["3 Aug", "NeoDove", "Priority-dial 'Call now' hand-off built, then removed on request; flag cleared", "", "Removed"],
    ["1–3 Aug", "Leads", "Dedupe consolidated — four disagreeing implementations replaced by one engine", "", "In Progress"],
    ["1–3 Aug", "Leads", "Duplicate-lead bug found: phone matched as exact text, so two formats made two dealers", "", "Gap"],
    ["1–3 Aug", "Leads", "Add Lead modal with a live duplicate check", "", "In Progress"],
    ["1–3 Aug", "Leads", "Activity timeline on the lead page; external calls counted in Call History", "", "In Progress"],
    ["Open", "Notifications", "Archive / delete columns are written in a migration that is not applied anywhere", "E-200", "Not applied"],
    ["Open", "Notifications", "The agreement-signed notification copy exists but nothing calls it — nobody is told today", "", "Gap"],
    ["Open", "Leads", "15 phone numbers already carry duplicate leads; the fix stops new ones but does not merge these", "", "Gap"],
    ["Open", "NeoDove", "The receiving campaign has no agents in NeoDove, so pushed leads cannot be worked", "", "Open"],
    ["Open", "EMI tracker", "E-171/172/173 and E-029 remain unapplied, so parts of the tracker are not live", "", "Not applied"],
];

function sheetChanges(wb) {
    const ws = wb.addWorksheet("Changes");
    // Wider first two columns than the standard layout: this sheet is a table, not
    // a bulleted narrative, so a 4-wide bullet column would clip every date.
    styleSheet(ws, [13, 20, 86, 18, 16]);
    title(ws, "Changes — master list, 26 May to 3 August 2026");

    const hdr = ws.addRow(["DATE", "AREA", "WHAT CHANGED", "MIGRATION", "STATUS"]);
    hdr.height = 20;
    for (let c = 1; c <= 5; c++) {
        hdr.getCell(c).font = { bold: true, size: 10, color: { argb: "FFFFFFFF" }, name: "Calibri" };
        hdr.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF374151" } };
        hdr.getCell(c).alignment = { vertical: "middle", horizontal: c === 3 ? "left" : "center" };
    }

    for (const [date, area, what, mig, status] of CHANGES) {
        const r = ws.addRow([date, area, what, mig, null]);
        r.getCell(1).font = { size: 10, color: { argb: "FF374151" }, name: "Calibri" };
        r.getCell(1).alignment = { vertical: "top", horizontal: "center" };
        r.getCell(2).font = { bold: true, size: 10, name: "Calibri" };
        r.getCell(2).alignment = { vertical: "top", wrapText: true };
        r.getCell(3).font = { size: 10, name: "Calibri" };
        r.getCell(3).alignment = { vertical: "top", wrapText: true };
        r.getCell(4).font = { size: 9, color: { argb: "FF6B7280" }, name: "Calibri" };
        r.getCell(4).alignment = { vertical: "top", horizontal: "center" };
        chip(r.getCell(5), status);
    }
    ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2 + CHANGES.length, column: 5 } };
    return ws;
}

// ── Rows appended to the carried-over Migrations and Work Log sheets ───────────
const NEW_MIGRATIONS = [
    ["E-220_lead_visit_meeting_mode", "Meeting mode on lead_visits so a WhatsApp meeting and a doorstep visit are distinguishable — backs the CEO Meetings report. Existing rows backfilled to 'ground'. Applied to db-1 on 29 Jul.", "Applied"],
    ["E-221_lead_quote_approval", "Approval gate on dealer quotes: every quote issue or revision lands pending and waits for the CEO. Existing rows backfilled to approved so history is not retroactively invalidated. Applied to db-1 on 29 Jul.", "Applied"],
    ["E-222_security_auto_block_event", "COMMENT-ONLY, no DDL. Documents the ip_blocked event type and the evidence key taxonomy for the auto-block layer. Not applied anywhere — harmless, because there is nothing to run.", "Not applied"],
    ["E-224_neodove_integration", "Three tables for the NeoDove two-way sync plus two denormalised columns on dealer_leads. The sync-events table is a reconciliation ledger, not a log, because NeoDove cannot be queried. Applied to db-1 on 1 Aug.", "In Progress"],
    ["E-225_neodove_campaign_mirror", "One jsonb column recording what a human has OBSERVED about a campaign inside NeoDove — descriptive, never authoritative. Applied to db-1 on 3 Aug.", "In Progress"],
    ["E-226_neodove_call_recording_and_priority_dial", "Recording URL and external agent name on lead_touchpoints, plus the priority-dial flag. The two touchpoint columns are deliberately NOT mirrored in the schema object, because that would break every touchpoint write on any database without this file. Applied to db-1 on 3 Aug.", "In Progress"],
    ["E-223_scrap_vendor_onboarding", "Scrap-vendor onboarding with generated portal credentials. Part of the battery-buyback module — listed for completeness; ownership to confirm before this is claimed as my work.", "To confirm"],
];

const NEW_WORKLOG = [
    ["29 Jul", "Lead visit meeting mode + quote approval", "E-220 and E-221 — WhatsApp vs doorstep meetings split for the CEO report, and a CEO approval gate on dealer quotes.", "Completed"],
    ["31 Jul", "Auto-block event taxonomy documented", "E-222 — comment-only migration recording the ip_blocked type and the evidence keys.", "Completed"],
    ["1 Aug", "Live attack protection", "Repeat-offender IPs auto-banned with escalating duration; only public addresses bannable; source-IP resolution fixed. Live Attacks table on the IT dashboard.", "Completed"],
    ["1 Aug", "NeoDove two-way sync", "E-224 — campaign push, inbound webhook, reconciliation ledger, audience preview.", "In Progress"],
    ["3 Aug", "NeoDove campaign mirror and call evidence", "E-225 and E-226 — who works a campaign, plus recording URL and agent name on the touchpoint.", "In Progress"],
    ["3 Aug", "NeoDove payload confirmed", "The real webhook body was found in NeoDove's own sample curl and confirmed live; seven of nine field mappings were wrong and were corrected, and the payload is now pinned by tests.", "Completed"],
    ["1–3 Aug", "Lead dedupe consolidated", "Four disagreeing duplicate checks replaced by one engine; a live duplicate-lead bug found (phone compared as exact text) affecting 15 numbers.", "In Progress"],
    ["1–3 Aug", "Lead page timeline", "Activity timeline rendered on /leads/[id]; external calls now counted in Call History, Total Calls and Latest Status.", "In Progress"],
];

function appendItems(ws, rows) {
    ws.addRow([]);
    const r = ws.addRow(["Added after the 31 July report — 29 July to 3 August 2026"]);
    r.height = 22.05;
    ws.mergeCells(`A${r.number}:D${r.number}`);
    r.getCell(1).font = { bold: true, size: 12, color: { argb: "FFFFFFFF" }, name: "Calibri" };
    r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    r.getCell(1).alignment = { vertical: "middle" };
    for (const [a, b, c] of rows) item(ws, a, b, c);
}

// ── Cover ─────────────────────────────────────────────────────────────────────
function sheetCover(wb, manifest) {
    const ws = wb.addWorksheet("Cover");
    styleSheet(ws, [4, 34, 92, 22, 15]);
    title(ws, "iTarang — 6-Month Work Report");

    const r = ws.addRow([
        null,
        "Author: Aniket   ·   Period: February — 3 August 2026   ·   Generated: 3 August 2026",
    ]);
    r.getCell(2).font = { size: 10, italic: true, color: { argb: "FF374151" }, name: "Calibri" };

    ws.addRow([]);
    item(
        ws,
        "What this workbook is",
        "The February–May 3-month report and the 26 May–31 July update, merged into one document, plus the work neither of them covered: the NBFC EMI tracker, the loan product flow, live attack protection, customer-lead dedupe, the NeoDove integration and the Navprakruti design deliverable. Nothing from the earlier reports has been removed or reworded.",
        "Reference",
    );
    item(
        ws,
        "How to read it",
        "Part A is months 1–3, carried over unchanged. Part B is months 4–6 as previously written. Part C is work reported here for the first time. Part D holds the migration list, the dated work log and the Changes master list.",
        "Reference",
    );
    item(
        ws,
        "Start with Changes",
        "The Changes sheet is a single flat table of every change made after the 3-month report — date, area, what changed, migration and status. It is the fastest way to see the whole second half, and it is filterable.",
        "Reference",
    );

    section(ws, "Table of contents", "Reference");
    for (const [name, part, desc] of manifest) {
        const row = ws.addRow([null, name, desc]);
        row.getCell(2).font = { bold: true, size: 10, name: "Calibri" };
        row.getCell(2).alignment = { vertical: "top", wrapText: true };
        row.getCell(3).font = { size: 10, name: "Calibri" };
        row.getCell(3).alignment = { vertical: "top", wrapText: true };
        chip(row.getCell(5), part);
    }

    section(ws, "Notes on accuracy", "Reference");
    item(ws, "Applied is not the same as written", "A migration can be merged in code and still be waiting to be run on a database. There is no automatic runner. Where a feature's migration is unapplied, the status column says so instead of 'Completed'.", "Reference");
    item(ws, "db-1 is sandbox, db-2 is production", "There are only two databases. The four columns on the Migrations sheet are two pairs, so something is genuinely unapplied on production only when both production columns are unticked.", "Reference");
    item(ws, "Migration numbers repeat", "Several E-numbers were taken twice on different branches — notably E-185–E-188, where the risk-engine family here is mine and the battery-buyback family is not. Always match on the full filename.", "Reference");
    item(ws, "The battery-buyback module is excluded", "The buyback and scrap-vendor marketplace in this repository is another team member's work and is deliberately not reported here.", "Scope note");
    item(ws, "1–3 August is in progress", "The NeoDove integration and the lead-dedupe work are written and running on sandbox but not yet committed. They are marked In Progress rather than delivered.", "In Progress");
    return ws;
}

// ── Build ─────────────────────────────────────────────────────────────────────
const PART_B = [
    ["0. Summary", "0. Summary"],
    ["1. WhatsApp End-to-End", "1. WhatsApp End-to-End"],
    ["2. NBFC File Process", "2. NBFC File Process"],
    ["3. Risk Engine & Sandbox", "3. Risk Engine & Sandbox"],
    ["4. IT Dashboard & Security", "4. IT Dashboard & Security"],
    ["5. Notification Engine", "5. Notification Engine"],
    ["6. CRM Workflow Changes", "6. CRM Workflow Changes"],
];

async function main() {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(SRC_3M);

    const upd = new ExcelJS.Workbook();
    await upd.xlsx.readFile(SRC_UPD);

    // Free the name "Cover" for the new 6-month cover.
    const oldCover = wb.getWorksheet("Cover");
    if (oldCover) oldCover.name = "Cover (3-Month)";

    for (const [src, dest] of PART_B) {
        const s = upd.getWorksheet(src);
        if (!s) throw new Error(`Part B source sheet missing: ${src}`);
        copySheet(s, wb, dest);
    }

    sheetEmiTracker(wb);
    sheetLoanProduct(wb);
    sheetLiveAttack(wb);
    sheetLeadsDedupe(wb);
    sheetNeodove(wb);
    sheetNavprakruti(wb);

    // Migrations and Work Log are CARRIED OVER and then extended, rather than
    // rebuilt, so the E-164..E-219 rows keep their original wording exactly.
    // NOTE the source name is "7. Migrations Shipped", not "7. Migrations".
    const migSrc = upd.getWorksheet("7. Migrations Shipped");
    const logSrc = upd.getWorksheet("8. Work Log");
    if (!migSrc || !logSrc) throw new Error("Migrations / Work Log source sheet missing");
    const mig = copySheet(migSrc, wb, "13. Migrations");
    appendItems(mig, NEW_MIGRATIONS);
    const log = copySheet(logSrc, wb, "14. Work Log");
    appendItems(log, NEW_WORKLOG);

    sheetChanges(wb);

    const manifest = [
        ["Cover (3-Month)", "Part A", "The original 3-month cover and table of contents, untouched."],
        ["Dealer Onboarding", "Part A", "The 6-step dealer onboarding wizard."],
        ["Admin Dashboard", "Part A", "NBFC, admin and inventory sections."],
        ["Dealer Dashboard", "Part A", "Sales and operations navbars."],
        ["NBFC Onboarding", "Part A", "The full 6-step admin-side NBFC wizard."],
        ["NBFC Dashboard", "Part A", "Portfolio, risk, recovery and compliance."],
        ["WhatsApp Onboarding", "Part A", "The original conversational onboarding bot."],
        ["Sheet1", "Part A", "NBFC addendum — list of BRD changes."],
        ["Sheet2", "Part A", "Empty in the original; kept as-is."],
        ["0. Summary", "Part B", "Executive summary of months 4–6."],
        ["1. WhatsApp End-to-End", "Part B", "The WhatsApp channel: four consoles, three journeys."],
        ["2. NBFC File Process", "Part B", "The Acquire workspace and the two-way document loop."],
        ["3. Risk Engine & Sandbox", "Part B", "Computed risk cards and the Python sandbox."],
        ["4. IT Dashboard & Security", "Part B", "The 'it' role, the scanner and the detector."],
        ["5. Notification Engine", "Part B", "One notification hub for every portal."],
        ["6. CRM Workflow Changes", "Part B", "Accounts, onboarding, validation, KYC, calculator, inventory, infra, mobile, UAT."],
        ["7. NBFC EMI Tracker", "Part C", "Portfolio EMI view, the bulk upload and the scoring cascade."],
        ["8. Loan Product Flow", "Part C", "Product configuration through to sanction — and what changed in this period."],
        ["9. Live Attack Protection", "Part C", "The 1 August auto-block layer that extends sheet 4."],
        ["10. Customer Leads & Dedupe", "Part C", "One dedupe engine, the lead registry and the duplicate-lead bug."],
        ["11. NeoDove Integration", "Part C", "Two-way telecalling sync and the payload discovery."],
        ["12. Navprakruti Costing", "Part C", "Design and costing deliverable — not CRM code."],
        ["13. Migrations", "Part D", "Every migration written this period, E-164 to E-226, with where it is applied."],
        ["14. Work Log", "Part D", "The same work in date order."],
        ["Changes", "Part D", "Master list of every change after the 3-month report. Start here."],
    ];
    sheetCover(wb, manifest);

    // Order: new Cover first, then the base sheets, Part B, C, D, Changes last.
    const desired = [
        "Cover",
        ...manifest.map(([n]) => n).filter((n) => n !== "Changes"),
        "Changes",
    ];
    desired.forEach((name, i) => {
        const ws = wb.getWorksheet(name);
        if (!ws) throw new Error(`Sheet missing when ordering: ${name}`);
        ws.orderNo = i;
    });

    await wb.xlsx.writeFile(OUT);

    console.log(`WROTE  ${OUT}`);
    console.log(`SHEETS ${wb.worksheets.length}`);
    for (const ws of wb.worksheets) {
        console.log(`  ${String(ws.orderNo).padStart(2)}  ${ws.name.padEnd(30)} rows=${ws.rowCount}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
