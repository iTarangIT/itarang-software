/**
 * Generates the "NBFC Dashboard - Acquire Flow: Change Request" Word document.
 * Point-wise required changes (7 points) + a box-and-arrow flow diagram of the
 * NBFC <-> Admin <-> Dealer request loop. Saves to Downloads.
 *
 * Run: node scripts/gen-nbfc-acquire-change-doc.mjs
 */
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle,
} from "docx";
import fs from "node:fs";

const OUT = "C:/Users/Aniket/Downloads/NBFC_Acquire_Flow_Change_Request.docx";

// ---------- text helpers ----------
const H1 = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_1, spacing: { before: 260, after: 100 } });
const H2 = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_2, spacing: { before: 180, after: 80 } });
const P = (t) => new Paragraph({ children: [new TextRun(t)], spacing: { after: 100 } });
const B = (label, t) => new Paragraph({ children: [new TextRun({ text: label + " ", bold: true }), new TextRun(t)], spacing: { after: 80 } });
const LI = (t) => new Paragraph({ text: t, bullet: { level: 0 }, spacing: { after: 40 } });
const NOTE = (t) => new Paragraph({ children: [new TextRun({ text: t, italics: true, color: "595959" })], spacing: { after: 100 } });
const gap = (after = 80) => new Paragraph({ text: "", spacing: { after } });

// ---------- table helpers ----------
const border = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };

function cell(text, { bold = false, fill, width } = {}) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    shading: fill ? { fill } : undefined,
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
    children: String(text).split("\n").map((line) =>
      new Paragraph({ children: [new TextRun({ text: line, bold })] })),
  });
}
// header cells with white bold text (build directly for readability on dark fill)
function headerCell(text, width) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    shading: { fill: "1F4E79" },
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
    children: [new Paragraph({ children: [new TextRun({ text: String(text), bold: true, color: "FFFFFF" })] })],
  });
}
function table2(headers, rows, widths) {
  const headRow = new TableRow({ tableHeader: true, children: headers.map((h, i) => headerCell(h, widths && widths[i])) });
  const bodyRows = rows.map((r) =>
    new TableRow({ children: r.map((c, i) => cell(c, { width: widths && widths[i] })) }));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders, rows: [headRow, ...bodyRows] });
}

// "Current state -> Required change" two-column block
function currentVsChange(currentText, changeText) {
  return table2(
    ["Current state", "Required change"],
    [[currentText, changeText]],
    [42, 58],
  );
}

// ---------- flow-diagram helpers (box-and-arrow) ----------
const boxBorder = { style: BorderStyle.SINGLE, size: 10, color: "1F4E79" };
const boxBorders = { top: boxBorder, bottom: boxBorder, left: boxBorder, right: boxBorder };

function flowBox(title, body, fill = "EAF1FB") {
  const kids = [new Paragraph({ children: [new TextRun({ text: title, bold: true, color: "1F4E79" })], alignment: AlignmentType.CENTER })];
  if (body) kids.push(new Paragraph({ children: [new TextRun({ text: body, size: 20 })], alignment: AlignmentType.CENTER, spacing: { before: 30 } }));
  return new Table({
    width: { size: 82, type: WidthType.PERCENTAGE },
    alignment: AlignmentType.CENTER,
    borders: boxBorders,
    rows: [new TableRow({ children: [new TableCell({ shading: { fill }, margins: { top: 90, bottom: 90, left: 120, right: 120 }, children: kids })] })],
  });
}
const arrow = (label) => new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 30, after: 30 },
  children: [new TextRun({ text: label ? `↓  ${label}` : "↓", bold: true, size: 22, color: "C00000" })],
});
const arrowUp = (label) => new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 30, after: 30 },
  children: [new TextRun({ text: `↑  ${label}`, bold: true, size: 22, color: "548235" })],
});

// ============================================================
const children = [
  // ---- Title ----
  new Paragraph({ text: "NBFC Dashboard – Acquire Flow", heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
  new Paragraph({ children: [new TextRun({ text: "Change Request Document", bold: true, size: 28 })], alignment: AlignmentType.CENTER, spacing: { after: 60 } }),
  new Paragraph({ children: [new TextRun({ text: "Prepared: 21 July 2026   •   For: Technical review / demo (rescheduled to Thursday)", italics: true, color: "595959" })], alignment: AlignmentType.CENTER, spacing: { after: 240 } }),

  H1("1. Purpose"),
  P("This document lists, point by point, the changes required to the NBFC dashboard “Acquire” file flow, as requested by the team. The core change is to turn the NBFC Acquire workspace from a read-only file review (where the NBFC can only submit an offer) into an interactive, two-way document & KYC verification flow between the NBFC, the Admin, and the Dealer."),
  P("Today the NBFC Acquire workspace (Verification → Offer → FI & V-KYC → E-NACH & Agreement → Disbursal) shows the customer dossier as read-only. The NBFC has no per-document KYC verification, no way to raise a correction / additional-document request, no direct line to the admin, and no DPDP consent access. The 7 changes below add exactly these capabilities, with the admin sitting in the middle as reviewer and router."),
  NOTE("Legend used below: “Current state” = how it behaves in the product today; “Required change” = what to build. Screen / component names are included so the dev team can locate each change."),

  // ---- Summary table ----
  H1("2. Summary of the 7 changes"),
  table2(
    ["#", "Change", "Where it lands", "Status"],
    [
      ["1", "NBFC verifies each customer / co-borrower document in its own dashboard (KYC verification, like the admin side)", "NBFC", "New"],
      ["2", "NBFC 'Request Correction' & 'Request Additional Documents' buttons (with comments) → Admin → Dealer → back to NBFC", "NBFC → Admin → Dealer", "New"],
      ["3", "Admin can write / update directly to the NBFC (no dealer round-trip needed)", "Admin → NBFC", "New"],
      ["4", "Step 4 (Product Selection): NBFC can ask for extra documents / images / videos — up to 10 items — customer sends, admin reviews, admin pushes to NBFC", "NBFC → Admin → Dealer/Customer", "New / Extend"],
      ["5", "Post-Step-4 flow must work end-to-end; admin gets website + email notifications; admin can also action the flow from the email", "Admin (web + email)", "New / Extend"],
      ["6", "NBFC's requested-docs & additional-docs are visible in the Admin KYC review, below an 'NBFC KYC Verification' card", "Admin", "New / Extend"],
      ["7", "DPDP consent sign access in the NBFC dashboard", "NBFC", "New"],
    ],
    [5, 55, 25, 15],
  ),
  gap(),

  // ---- Detailed change points ----
  H1("3. Required changes — point by point"),

  H2("Change 1 — KYC verification on the NBFC side"),
  P("KYC verification results currently come only from the Admin dashboard. The NBFC needs its own KYC verification screen: the NBFC partner should be able to verify each and every customer and co-borrower document inside its dashboard — exactly like the KYC verification cards the admin uses."),
  currentVsChange(
    "In the Acquire workspace the customer dossier (Aadhaar, PAN, Bank, RC, co-borrower docs, supporting docs) is shown read-only. The NBFC cannot mark documents verified / not verified.",
    "Add per-document KYC verification cards to the NBFC 'Verification' stage — one card per document with a verify / query state and NBFC notes — mirroring the admin KYC cards. Verification is recorded per NBFC and kept separate from the admin's own verification.",
  ),
  B("Affected screens / components:", "NBFC Acquire – Verification stage: CustomerDossierPanel.tsx (src/app/(dashboard)/nbfc/acquire/[leadId]/_components/). Reuse the admin KYC card set src/components/kyc/cards/* (AadhaarCard, PANCard, BankCard, CIBILCard, RCCard)."),
  gap(),

  H2("Change 2 — NBFC document request loop (correction + additional documents)"),
  P("If the NBFC wants any customer / co-borrower document corrected or added, it must be flexible: the NBFC gets two buttons — Request Correction and Request Additional Documents — each carrying the NBFC's comments. That request goes to the Admin dashboard first. The admin reviews the NBFC request, then passes it to the Dealer. In Step 3 / Step 4 the dealer updates the requested / additional documents; the update comes back to the Admin dashboard, and the admin then updates it to the NBFC dashboard. (This loop is drawn in Section 4.)"),
  currentVsChange(
    "Correction / additional-document requests can only be raised by the ADMIN toward the dealer (existing correction rounds and requested-docs). The NBFC has no way to originate such a request.",
    "Add 'Request Correction' and 'Request Additional Documents' buttons (with a comment box) on each NBFC document card. Create an NBFC-originated request that is routed to the admin, reviewed by the admin, forwarded to the dealer, fulfilled by the dealer, reviewed again by the admin, then reflected back on the NBFC dashboard — with status visible at every hop.",
  ),
  B("Affected screens / components:", "New NBFC request action on the Verification cards (CP-1). Admin side reuses / extends the request-docs & correction machinery: otherDocumentRequests (schema.ts:1820) and dealerCorrectionRounds (schema.ts:4780); admin review in CaseReview.tsx. Dealer fulfils via the existing tokenised upload flow."),
  gap(),

  H2("Change 3 — Admin can write / update directly to the NBFC"),
  P("The admin should be able to write and update directly to the NBFC dashboard — i.e. reply to an NBFC request, or push an update to the NBFC, without always needing a dealer round-trip."),
  currentVsChange(
    "There is no admin → NBFC message / update channel. The admin cannot post a note or an update that appears on the NBFC's Acquire screen.",
    "Add an admin control (on the admin KYC review / lead screen) to post a comment or update straight to the NBFC dashboard for that lead. The NBFC sees it against the lead in Acquire. Used both to answer an NBFC request directly and to send proactive updates.",
  ),
  B("Affected screens / components:", "Admin KYC review CaseReview.tsx (admin/kyc-review/[leadId]) → writes to the shared NBFC request/thread; surfaces on the NBFC Acquire lead detail."),
  gap(),

  H2("Change 4 — Step 4 (Product Selection): NBFC extra-item request, up to 10 items"),
  P("At Step 4 (Product Selection), if the NBFC wants some extra documents / images / videos, the customer can send up to a maximum of 10 such things from Step 4. The admin reviews them in the dashboard and then updates / pushes them to the NBFC partner."),
  currentVsChange(
    "Step 4 / Product Selection is captured once and shown read-only to the NBFC. There is no channel for the NBFC to ask for extra media, and no cap-limited upload from Step 4.",
    "Extend Step 4 with an NBFC 'extra items' request: mixed types (documents, images, videos), hard cap of 10 items total. The customer / dealer uploads them from Step 4, the admin reviews each item, and the admin pushes the reviewed items to the NBFC. Enforce the 10-item limit and support all common file formats.",
  ),
  B("Affected screens / components:", "Step 4 product-selection stage (dealer submit-product-selection flow) + the NBFC Section-G / product cards in CustomerDossierPanel.tsx; admin review queue for the extra items; push to NBFC Acquire."),
  gap(),

  H2("Change 5 — Make the post-Step-4 flow work; website + email notifications; act from email"),
  P("After Step 4 (Product Selection) the flow must work end-to-end. The admin should get the notification both from the website and by email, and through the email the admin should be able to update / action the flow as well — i.e. give flow access through the mail."),
  currentVsChange(
    "In-app notifications today target the DEALER only (src/lib/notifications.ts); there is no admin in-app notification and no way to act on a request from an email. Email transport exists but only sends plain notices.",
    "1) Ensure every post-Step-4 transition fires. 2) Add ADMIN-targeted in-app notifications for NBFC requests / dealer uploads. 3) Send the admin an email for each event with tokenised action links so the admin can approve / forward / push-to-NBFC directly from the email.",
  ),
  B("Affected screens / components:", "notifications table + src/lib/notifications.ts (add admin-targeted helpers); email via src/lib/email/mailer.ts (AgentMail → SMTP); tokenised action-link routes for the email actions."),
  gap(),

  H2("Change 6 — NBFC requests visible in the Admin KYC review, under an 'NBFC KYC Verification' card"),
  P("The KYC-verification requested-docs and additional-docs requests coming from the NBFC should all be visible in the Admin KYC review — displayed below an 'NBFC KYC Verification' card — so the admin sees, in one place, everything the NBFC has asked for."),
  currentVsChange(
    "The admin KYC review shows only the admin's own verification cards. NBFC-side activity is not visible there.",
    "Add an 'NBFC KYC Verification' card to the admin KYC review, and list every NBFC-originated correction / additional-doc request (with the NBFC's comments and current status) directly below it.",
  ),
  B("Affected screens / components:", "Admin KYC review CaseReview.tsx (admin/kyc-review/[leadId]) — new NBFC verification/request summary card fed by the CP-2 request records."),
  gap(),

  H2("Change 7 — DPDP consent sign access in the NBFC dashboard"),
  P("Give DPDP consent sign access in the NBFC dashboard — the NBFC should be able to view / sign / track the DPDP consent for the lead."),
  currentVsChange(
    "DPDP consent is captured and signed on the customer / dealer side (consent-service.ts, consentRecords). The NBFC dashboard has no consent surface.",
    "Surface DPDP consent (view, sign where applicable, and track status) inside the NBFC Acquire workspace for the lead.",
  ),
  B("Affected screens / components:", "NBFC Acquire lead detail; consent via src/lib/kyc/consent-service.ts + consentRecords (schema.ts:1574)."),
  gap(160),

  // ---- Flow diagram ----
  H1("4. Flow diagram — NBFC ⇄ Admin ⇄ Dealer request loop"),
  P("The arrow diagram below shows the new request loop (Changes 2, 3, 4 and 6). Solid down-arrows (↓) are the forward path; the green up-arrow (↑) is the return of the completed work back up to the NBFC. Box colour: blue = NBFC, grey = Admin, amber = Dealer / Customer."),
  gap(),

  flowBox("1. NBFC dashboard (Acquire – Verification)", "Verifies each customer / co-borrower document. Clicks 'Request Correction' or 'Request Additional Documents' and adds comments. (Ch. 1 & 2)", "DCE6F7"),
  arrow("request + comments"),
  flowBox("2. Admin dashboard – review NBFC request", "Admin reviews the NBFC request. Can edit / add. Then EITHER forwards it to the dealer, OR replies / updates the NBFC directly (Ch. 3).", "EDEDED"),
  arrow("forward to dealer (Step 3 / Step 4)"),
  flowBox("3. Dealer / Customer", "Uploads the corrected / additional documents. At Step 4 can also send extra documents / images / videos — up to 10 items (Ch. 4). All common formats.", "FBE7D3"),
  arrow("uploaded items"),
  flowBox("4. Admin dashboard – review uploaded items", "Admin reviews what the dealer / customer uploaded, then pushes the reviewed items up to the NBFC.", "EDEDED"),
  arrowUp("admin updates the NBFC"),
  flowBox("5. NBFC dashboard – updated", "Updated / additional documents and items are now visible against the lead. NBFC continues the Acquire flow (Offer → …).", "DCE6F7"),
  gap(120),

  H2("Side path — notifications after Step 4 (Change 5)"),
  flowBox("Step 4 Product Selection submitted / NBFC extra-item request", "", "FBE7D3"),
  arrow("triggers notification"),
  flowBox("Admin notified", "In-website notification AND email. The email carries action links so the admin can approve / forward / push-to-NBFC straight from the mail.", "EDEDED"),
  arrow("admin action (web or email)"),
  flowBox("Update pushed to NBFC partner", "", "DCE6F7"),
  gap(160),

  // ---- Appendix ----
  H1("Appendix A — Affected screens & components (for the dev team)"),
  table2(
    ["Change", "Primary file(s) / area"],
    [
      ["1 – NBFC KYC verification", "nbfc/acquire/[leadId]/_components/CustomerDossierPanel.tsx; reuse src/components/kyc/cards/*"],
      ["2 – NBFC request loop", "New NBFC request records; otherDocumentRequests (schema.ts:1820), dealerCorrectionRounds (schema.ts:4780); CaseReview.tsx"],
      ["3 – Admin → NBFC direct", "admin/kyc-review/[leadId] → CaseReview.tsx; NBFC Acquire lead detail thread"],
      ["4 – Step 4 extra items (max 10)", "Dealer submit-product-selection flow; Section-G / product cards; admin review; push to NBFC"],
      ["5 – Notifications + email actions", "notifications table + src/lib/notifications.ts (admin helpers); src/lib/email/mailer.ts; tokenised action routes"],
      ["6 – NBFC card in admin KYC review", "CaseReview.tsx — new 'NBFC KYC Verification' card"],
      ["7 – DPDP consent in NBFC", "NBFC Acquire lead detail; src/lib/kyc/consent-service.ts; consentRecords (schema.ts:1574)"],
    ],
    [30, 70],
  ),
  gap(),
  NOTE("Note: the NBFC Acquire workspace today is a 5-stage stepper — Verification → Offer → FI & V-KYC → E-NACH & Agreement → Disbursal (src/app/(dashboard)/nbfc/acquire/). All 7 changes attach to the Verification / Product-Selection portions of this flow; the offer and downstream stages are unchanged."),
];

const doc = new Document({
  styles: {
    default: {
      document: { run: { font: "Calibri", size: 22 } },
    },
  },
  sections: [{ children }],
});
const buf = await Packer.toBuffer(doc);
fs.writeFileSync(OUT, buf);
console.log(`Saved: ${OUT}`);
console.log(`Size: ${(buf.length / 1024).toFixed(1)} KB`);
