/**
 * Generates a plain-language Word doc explaining the NBFC Battery Monitoring
 * metrics (DPD/EMI, CDS, PCI, Risk, Confidence, Freshness, Alerts) — what each
 * is, why it matters, how it's computed, and the file + function behind it.
 * Saves to the user's Downloads folder.
 */
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
} from "docx";
import fs from "node:fs";

const OUT = "C:/Users/Aniket/Downloads/iTarang_NBFC_Metrics_Explained_v2.docx";

const H1 = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } });
const H2 = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 } });
const P = (t) => new Paragraph({ children: [new TextRun(t)], spacing: { after: 100 } });
const B = (label, t) => new Paragraph({ children: [new TextRun({ text: label + " ", bold: true }), new TextRun(t)], spacing: { after: 80 } });
const LI = (t) => new Paragraph({ text: t, bullet: { level: 0 }, spacing: { after: 40 } });
const CODE = (t) => new Paragraph({ children: [new TextRun({ text: t, font: "Consolas", size: 20 })], spacing: { after: 100 }, shading: { fill: "F2F2F2" } });
const SRC = (file, fn) => new Paragraph({
  children: [
    new TextRun({ text: "Where in the code: ", bold: true, italics: true, size: 20 }),
    new TextRun({ text: `${file}`, font: "Consolas", size: 20 }),
    new TextRun({ text: fn ? `  →  ${fn}` : "", font: "Consolas", size: 20 }),
  ],
  spacing: { after: 160 },
});

const children = [
  new Paragraph({ text: "iTarang NBFC Portal — Battery Monitoring Metrics Explained", heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
  new Paragraph({ children: [new TextRun({ text: "A simple guide to what each column means, why it's there, and how it's calculated.", italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 240 } }),

  H1("Quick overview"),
  P("The Battery Monitoring table shows one row per financed battery/loan. Most columns answer one of two questions: 'Is the customer paying their EMIs?' (credit health) or 'Is the battery healthy and reporting?' (hardware health)."),
  LI("Credit health (from EMI payment history): DPD/EMI, CDS, PCI, Risk, Confidence."),
  LI("Hardware health (from the battery's IoT device on the VPS): SOH, Freshness, and the per-battery Alerts count."),

  // DPD / EMI
  H1("1. DPD and the EMI column"),
  B("What it is:", "DPD = 'Days Past Due' — how many days late the borrower's oldest unpaid EMI is. The EMI column turns this into words: '0' shows as 'On time', any positive number shows as 'N days overdue'."),
  B("Why it's needed:", "It's the fastest way to see who is behind on payments and by how much — the first signal of trouble before deeper scores are even looked at."),
  B("How it's calculated:", "Take the oldest EMI installment that is due but not yet paid, and count the days from its due date to today. If every due EMI is paid, DPD = 0."),
  CODE("DPD = today − (due date of the oldest unpaid, past-due EMI)"),
  B("Example:", "Sami's 3rd EMI was never paid; its due date is ~111 days ago → DPD 111 → '111 days overdue'. Kasim paid all his due EMIs → DPD 0 → 'On time'."),
  SRC("nbfc_loans table (column: current_dpd); rendered in BatteriesTable.tsx", "EMI column render"),

  // CDS
  H1("2. CDS — Credit Default Score"),
  B("What it is:", "A score from 0 to 100 that estimates how likely the borrower is to default (stop paying). Higher = worse."),
  B("Why it's needed:", "DPD only tells you 'late or not'. CDS looks at the whole recent payment pattern (including how late, and repeated misses) to give a single risk number the NBFC can act on."),
  B("How it's calculated (in plain steps):", "It looks at the last 6 EMIs (most recent first) and:"),
  LI("Step A — scores each EMI by how badly it was paid: paid on time = 0; a little late = 0.5; very late = 0.7; overdue = 0.6 to 1.0 depending on how many days; missed = 1.0; not yet due = 0."),
  LI("Step B — gives recent months more importance (newest EMI counts ×1.0, then ×0.88, ×0.76, … down to ×0.40)."),
  LI("Step C — adds an extra penalty for consecutive misses in a row (each one adds 0.5)."),
  LI("Step D — adds a tiny penalty if the battery hasn't reported in over 12 hours (offline = slightly riskier). No telemetry = no penalty."),
  LI("Step E — scales the total to a clean 0–100 number."),
  CODE("CDS = (weighted EMI penalties + streak penalty + telemetry penalty) ÷ (maximum possible) × 100"),
  B("Example:", "Ali Khan missed/was-late on most recent months → CDS 81.8 (high). Kasim paid everything → CDS 3.6 (low)."),
  SRC("src/lib/nbfc/cds/computeCds.ts", "computeCdsForLoan()  (helpers: emiWeight(), recencyMultiplier())"),

  // PCI
  H1("3. PCI — Payment Consistency Index"),
  B("What it is:", "A score from 0.0 to 1.0 measuring how consistently the borrower pays on time. Higher = better. It is the positive mirror of CDS."),
  B("Why it's needed:", "CDS focuses on risk/penalty; PCI gives a clean 'reliability' reading that's easy to compare and is used to trigger early-warning alerts."),
  B("How it's calculated:", "For the last 6 EMIs: paid on time = 1.0, paid slightly late (under 7 days) = 0.5, missed/overdue = 0.0. Then take a recency-weighted average (newest EMI weighted highest)."),
  CODE("PCI = sum(EMI score × recency weight) ÷ sum(weights)   → between 0 and 1"),
  B("Early warning:", "If PCI drops below 0.40, the system automatically raises a credit alert (severity 'critical' below 0.20, otherwise 'high')."),
  B("Example:", "Satyapal paid every EMI → PCI 1.00. Ali Khan rarely paid → PCI 0.05."),
  SRC("src/lib/nbfc/pci/computePci.ts", "pciFromEmis()  (helper: emiScore())"),

  // RISK
  H1("4. Risk"),
  B("What it is:", "A simple label — Low / Medium / High / Very High — placed on top of the CDS number."),
  B("Why it's needed:", "A coloured word is faster to scan than a number; it lets the team filter and prioritise at a glance."),
  B("How it's calculated:", "It is just a band over CDS (the cut-offs are configurable per NBFC):"),
  LI("CDS below 40 → Low"),
  LI("CDS 40 to 69 → Medium"),
  LI("CDS 70 to 84 → High"),
  LI("CDS 85 or above → Very High"),
  LI("No CDS yet → shown as '—'"),
  SRC("BatteriesTable.tsx (RiskBadge); thresholds from the nbfc_risk_rules table", "RiskBadge()"),

  // CONF
  H1("5. Confidence (CONF.)"),
  B("What it is:", "How much you can trust the CDS/PCI score for that loan — High, Medium, or Low."),
  B("Why it's needed:", "A score built from very little data (or stale telemetry) shouldn't be trusted as much as one built from a full history. Confidence makes that honesty visible."),
  B("How it's decided:", ""),
  LI("LOW — fewer than 3 EMIs on record, OR the loan was restructured."),
  LI("HIGH — at least 6 EMIs AND the battery reported within the last 12 hours."),
  LI("MEDIUM — everything in between (e.g. enough EMIs but no fresh telemetry)."),
  B("Note for the imported loans:", "We have EMI history but no live battery telemetry, so the best these reach is MEDIUM (and LOW where there are fewer than 3 EMIs so far)."),
  SRC("src/lib/nbfc/cds/computeCds.ts", "computeCdsForLoan()  (confidence block)"),

  // FRESHNESS
  H1("6. Freshness"),
  B("What it is:", "How recently the physical battery last reported its location/telemetry — shown as Fresh / Idle / Stale / Offline / Never."),
  B("Why it's needed:", "It tells you whether the live battery data (SOH, GPS, alerts) is trustworthy and whether the asset is still 'online'."),
  B("How it's calculated:", "Based on the time since the battery's last GPS ping:"),
  LI("Under 15 minutes → Fresh"),
  LI("Under 6 hours → Idle"),
  LI("Under 24 hours → Stale"),
  LI("24 hours or more → Offline"),
  LI("Never reported → 'Awaiting first ping'"),
  B("Important:", "This comes from the IoT device on the VPS, not from the loan/EMI data. If a battery isn't reporting, Freshness shows 'Never' and SOH shows '—'."),
  SRC("src/lib/iot/freshness.ts", "classifyFreshness()"),

  // ALERTS
  H1("7. Alerts"),
  B("What it is:", "There are two alert views, and they come from different places:"),
  H2("(a) The ALERTS column (per battery)"),
  B("Meaning:", "The count of open (unresolved) hardware alerts raised by that battery's IoT device — e.g. over/under-voltage, tampering. A red number means action is needed; '0' means none open."),
  B("How it's calculated:", "It counts rows in the IoT 'alerts' table for that battery serial where the alert has not yet been resolved."),
  CODE("open alerts = COUNT(alerts WHERE battery = this one AND resolved_at IS NULL)"),
  SRC("src/lib/db/iot-queries.ts", "getOpenAlerts()"),
  H2("(b) The four cards at the top (Critical / Warning / Info / Geo Variation)"),
  B("Meaning:", "A portfolio-level summary that blends the hardware alerts with the credit score (CDS):"),
  LI("CRITICAL — battery has an open alert AND CDS is high (70+): real trouble on both fronts."),
  LI("WARNING — medium credit risk (CDS 40+), or high risk but no live hardware alert."),
  LI("INFO — low credit concern (CDS under 40, or no score yet)."),
  LI("GEO VARIATION — battery has GPS coordinates available."),
  B("Also note:", "Credit alerts (like the PCI-below-0.40 warning) are stored separately in the nbfc_risk_alerts table and appear on the dedicated 'Risk Alerts' page — these are about payments, not hardware."),
  SRC("src/app/(dashboard)/nbfc/batteries/page.tsx", "criticalCount / warningCount card logic"),

  // SOH note + summary
  H1("8. A note on SOH (and what needs the battery feed)"),
  P("SOH (State of Health) is the battery's physical condition shown as a percentage. It is read straight from the IoT device (VPS vehicle_state.soh_pct) and is NOT calculated from loan data. If a battery isn't reporting, it shows '—'. The same applies to GPS/Geo, Freshness, and the hardware Alerts column."),

  H1("9. Worked example — due dates (start + N months) and DPD"),
  P("The sheet has no due date per installment, so each EMI's due date is generated as: Battery Installation Date + N months (installment 1 = start + 1 month, installment 2 = start + 2 months, and so on, up to the tenure)."),
  B("Sami Ur Rehman — start 26 Nov 2025, EMI ₹5,250, tenure 15:", ""),
  LI("#1 due 26 Dec 2025 — paid"),
  LI("#2 due 26 Jan 2026 — paid"),
  LI("#3 due 26 Feb 2026 — UNPAID ('Pending')  ← oldest unpaid → this drives DPD"),
  LI("#4 due 26 Mar 2026 — paid"),
  LI("#5 due 26 Apr 2026 — paid"),
  LI("#6 due 26 May 2026 — unpaid (22 days overdue)"),
  LI("#7 due 26 Jun 2026 — not due yet (future)"),
  LI("#8 to #15 due Jul 2026 … Feb 2027 — future"),
  CODE("DPD = today (17 Jun 2026) − 26 Feb 2026 = 111 days  → 'On time' would be 0; here '111d overdue'"),
  B("Why the oldest one matters:", "DPD measures the single oldest unpaid EMI, so even though Sami paid most months, that one old 'Pending' from February makes DPD 111. CDS/Risk stay Low because the overall recent pattern is mostly paid."),
  B("Same logic across all 7 loans:", ""),
  LI("Sami Ur Rehman — start 26 Nov 2025 → oldest unpaid #3 (26 Feb 2026) → DPD 111"),
  LI("Pappu — start 29 Nov 2025 → oldest unpaid #6 (29 May 2026) → DPD 19"),
  LI("Kasim — start 28 Dec 2025 → none unpaid past-due → DPD 0 (On time)"),
  LI("Ali Khan — start 12 Apr 2025 → oldest unpaid #8 (12 Dec 2025) → DPD 187"),
  LI("Satyapal — start 17 Jan 2026 → none unpaid past-due → DPD 0 (On time)"),
  LI("Nafees / Tufail — start 2 Apr 2026 → none unpaid past-due → DPD 0 (On time)"),
  LI("Munna lal — start 4 Jan 2026 → oldest unpaid #3 (4 Apr 2026) → DPD 74"),

  H1("Summary table (in words)"),
  LI("DPD / EMI — how late the customer is. From EMI due dates. (current_dpd)"),
  LI("CDS — likelihood of default, 0–100, higher worse. From recent EMI penalties. (computeCdsForLoan)"),
  LI("PCI — payment reliability, 0–1, higher better. From recent EMI scores. (pciFromEmis)"),
  LI("Risk — Low/Medium/High label over CDS. (RiskBadge)"),
  LI("Confidence — how trustworthy the score is. From EMI count + telemetry freshness. (computeCdsForLoan)"),
  LI("Freshness — when the battery last reported. From IoT GPS time. (classifyFreshness)"),
  LI("Alerts — open hardware alerts per battery + portfolio summary cards. (getOpenAlerts / page.tsx)"),
  LI("SOH — battery health %, from the IoT device only (not loan data)."),
];

const doc = new Document({ sections: [{ children }] });
const buf = await Packer.toBuffer(doc);
fs.writeFileSync(OUT, buf);
console.log(`Saved: ${OUT}`);
console.log(`Size: ${(buf.length / 1024).toFixed(1)} KB`);
