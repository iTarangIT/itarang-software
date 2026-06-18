/**
 * Generates a Word doc that explains DPD with the Sami Ur Rehman worked example,
 * matching the on-screen walkthrough (tables + steps). Saves to Downloads.
 */
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle,
} from "docx";
import fs from "node:fs";

const OUT = "C:/Users/Aniket/Downloads/DPD_Example_Explained.docx";

const H1 = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 100 } });
const P = (t) => new Paragraph({ children: [new TextRun(t)], spacing: { after: 100 } });
const B = (label, t) => new Paragraph({ children: [new TextRun({ text: label + " ", bold: true }), new TextRun(t)], spacing: { after: 80 } });
const LI = (t) => new Paragraph({ text: t, bullet: { level: 0 }, spacing: { after: 40 } });
const CODE = (t) => new Paragraph({ children: [new TextRun({ text: t, font: "Consolas", size: 22, bold: true })], spacing: { before: 60, after: 120 }, shading: { fill: "EAF3EA" } });

const border = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };

function cell(text, { bold = false, fill } = {}) {
  return new TableCell({
    shading: fill ? { fill } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({ children: [new TextRun({ text: String(text), bold })] })],
  });
}
function table(headers, rows, highlightRow = -1) {
  const headRow = new TableRow({ tableHeader: true, children: headers.map((h) => cell(h, { bold: true, fill: "D9E2F3" })) });
  const bodyRows = rows.map((r, i) =>
    new TableRow({ children: r.map((c) => cell(c, i === highlightRow ? { bold: true, fill: "FCE4D6" } : {})) }),
  );
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders, rows: [headRow, ...bodyRows] });
}
const gap = () => new Paragraph({ text: "", spacing: { after: 80 } });

const children = [
  new Paragraph({ text: "Understanding DPD (Days Past Due) — Worked Example", heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
  new Paragraph({ children: [new TextRun({ text: "Example customer: Sami Ur Rehman", italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 200 } }),

  H1("What DPD means (in one sentence)"),
  P("DPD = how many days have passed since the first EMI the customer skipped and still hasn't paid, up to today."),
  P("It answers: \"How long has this customer been behind on payments?\""),

  H1("Sami's data (straight from the Excel)"),
  LI("Battery Installation Date: 26 Nov 2025"),
  LI("EMI: Rs. 5,250 / month   |   Tenure: 15 months"),
  LI("Amounts collected: 1st = 5250, 2nd = 4800, 3rd = \"Pending\", 4th = 5250, 5th = 5250, 6th-7th = blank"),
  LI("Today: 17 June 2026"),

  H1("Step 1 - Work out each EMI's due date"),
  P("There is no due date in the sheet, so each EMI is due one month after the install date, then every month after:"),
  table(
    ["EMI #", "Due date (install + N months)"],
    [
      ["1", "26 Dec 2025"],
      ["2", "26 Jan 2026"],
      ["3", "26 Feb 2026"],
      ["4", "26 Mar 2026"],
      ["5", "26 Apr 2026"],
      ["6", "26 May 2026"],
      ["7", "26 Jun 2026"],
    ],
  ),
  gap(),

  H1("Step 2 - Mark each EMI paid or not (from the collected amounts)"),
  table(
    ["EMI #", "Due", "Collected?", "Status"],
    [
      ["1", "26 Dec 2025", "5250  (yes)", "paid"],
      ["2", "26 Jan 2026", "4800  (yes)", "paid"],
      ["3", "26 Feb 2026", "\"Pending\"  (no)", "NOT PAID"],
      ["4", "26 Mar 2026", "5250  (yes)", "paid"],
      ["5", "26 Apr 2026", "5250  (yes)", "paid"],
      ["6", "26 May 2026", "blank  (no)", "not paid"],
      ["7", "26 Jun 2026", "-", "not due yet (future)"],
    ],
    2, // highlight EMI #3
  ),
  gap(),

  H1("Step 3 - Find the OLDEST unpaid EMI that is already past its due date"),
  P("Two EMIs are unpaid and past-due: #3 (26 Feb 2026) and #6 (26 May 2026)."),
  P("The oldest of these is #3, due 26 Feb 2026 - this is the one that sets DPD."),
  P("(EMI #7 is also unpaid, but its due date 26 Jun 2026 is in the future, so it does not count.)"),

  H1("Step 4 - Count the days from that due date to today"),
  P("From 26 Feb 2026 to 17 Jun 2026:"),
  LI("Feb 26 -> Mar 26 = 28 days"),
  LI("Mar 26 -> Apr 26 = 31 days"),
  LI("Apr 26 -> May 26 = 30 days"),
  LI("May 26 -> Jun 26 = 31 days  ->  120 days to 26 Jun"),
  LI("But today (17 Jun) is 9 days before 26 Jun  ->  120 - 9 = 111 days"),
  CODE("DPD = 111   ->   the EMI column shows \"111 days overdue\""),

  H1("The key idea to remember"),
  P("Sami paid 4 of his 5 due EMIs - he is mostly a good payer. But because one EMI from February was never paid, DPD is high (111). DPD does not care how many he paid; it only measures how long the oldest unpaid EMI has been sitting unpaid."),
  P("That is also why Sami's Risk is \"Low\" (CDS 32) even with DPD 111 - Risk looks at his overall recent pattern (mostly paid), while DPD flags that one old gap. The two columns tell you different things:"),
  LI("DPD 111  ->  \"there is an old unpaid EMI, go collect it\""),
  LI("Risk Low  ->  \"but this person generally pays, so it is not a default situation\""),
  P("Compare with Kasim, who paid EMIs 1-5 and whose 6th is not due yet -> no unpaid past-due EMI -> DPD = 0 -> \"On time\"."),

  H1("Where this is in the code"),
  LI("Schedule (due dates = start + N months): src/lib/nbfc/servicing/projectDisbursedLoan.ts"),
  LI("DPD calculation + storage: scripts/import-emi-collect-data.ts  ->  nbfc_loans.current_dpd"),
  LI("EMI column display (On time / N days overdue): BatteriesTable.tsx"),
];

const doc = new Document({ sections: [{ children }] });
const buf = await Packer.toBuffer(doc);
fs.writeFileSync(OUT, buf);
console.log(`Saved: ${OUT}`);
console.log(`Size: ${(buf.length / 1024).toFixed(1)} KB`);
