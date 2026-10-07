/**
 * The .xlsx a scheduled digest can attach (E-287, generalised by E-288).
 *
 * TWO SHEETS, ONE DAY. "Figures" is what the mail said, so a disputed number can
 * be checked without recomputing it. "Detail" is every item behind those figures,
 * one row each, with an Action column naming its bucket.
 *
 * Deliberately NOT the "Export Excel" button on the queue screens: those dump the
 * WHOLE queue across a fixed column order their routes warn downstream consumers
 * key on by POSITION. Reusing one would have meant either refactoring a contract
 * other people depend on, or attaching an entire queue to a mail about one day.
 *
 * A pure lib module with no HTTP in it — modelled on
 * src/lib/leads/touchpointWorkbook.ts, the repo's template for a workbook a route
 * AND a headless job can both call. Styling comes from ./sheetStyle rather than a
 * fifth inline copy of the same header/zebra code.
 */

import ExcelJS from "exceljs";

import { fmtIst, styleHeader, zebra } from "./sheetStyle";
import type { DigestSections } from "@/lib/digests/schedule";
import type {
  DigestDetail,
  DigestFigures,
  DigestKindDescriptor,
  DigestTable,
} from "@/lib/digests/types";

export const FIGURES_SHEET_NAME = "Figures";
export const DETAIL_SHEET_NAME = "Detail";

/**
 * Exported so a test can assert the contract rather than restate it. Nothing
 * downstream keys on these by position — this sheet is read by humans — but a
 * silent column rename is still worth catching.
 */
export const DETAIL_COLUMNS = [
  "Action",
  "Item",
  "Detail",
  "City",
  "State",
  "Source",
  "When (IST)",
  "ID",
] as const;

export const FIGURES_COLUMNS = ["Block", "Figure", "Value"] as const;

/** The MIME type every xlsx in this repo is served and attached as. */
export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** `kyc-review-2026-08-31.xlsx` — the covered day, not the send date. */
export function digestWorkbookFilename(kindId: string, istDay: string): string {
  return `${kindId.replace(/_/g, "-")}-${istDay}.xlsx`;
}

export async function buildDigestWorkbook(args: {
  kind: DigestKindDescriptor;
  istDay: string;
  figures: DigestFigures;
  detail: DigestDetail;
  /** Omit whatever the admin switched off, so the sheet and the mail agree. */
  sections?: DigestSections;
}): Promise<ExcelJS.Workbook> {
  const on = (key: string) => args.sections?.[key] !== false;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "iTarang";
  workbook.created = new Date();

  // A digest that names sheets on its lines covers flows that must not share a
  // grid (scrap_buyback_daily: NBFC scrap vs dealer buyback). Each named sheet
  // gets its own figures block and its own detail block; the shared
  // Figures/Detail pair below is not written.
  const sheetNames = namedSheets(args.figures);
  if (sheetNames.length > 0) {
    for (const name of sheetNames) writeFlowSheet(workbook, name, args, on);
    return workbook;
  }

  // A digest made only of grid blocks (Sales Daily v1.1: every figure lives in
  // figures.tables) has nothing for the Figures/Detail pair to show — this used
  // to attach an empty Figures sheet and a "No activity" Detail sheet. Write
  // each block as mailed instead, one sheet per block.
  const tables = (args.figures.tables ?? []).filter((t) => on(t.key));
  if (
    tables.length > 0 &&
    args.figures.activity.length === 0 &&
    args.figures.backlog.length === 0
  ) {
    const used = new Set<string>();
    for (const t of tables) writeTableSheet(workbook, t, args.istDay, used, on);
    return workbook;
  }

  // ---- Sheet 1: the figures exactly as mailed -------------------------------
  const figuresSheet = workbook.addWorksheet(FIGURES_SHEET_NAME, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  figuresSheet.columns = [
    { header: "Block", key: "block", width: 18 },
    { header: "Figure", key: "figure", width: 40 },
    { header: "Value", key: "value", width: 16 },
  ];
  styleHeader(figuresSheet.getRow(1));

  let f = 0;
  for (const l of args.figures.activity.filter((x) => on(x.key))) {
    zebra(
      figuresSheet.addRow({
        block: args.istDay,
        figure: (l.indent ? "    " : "") + l.label,
        value: l.value,
      }),
      ++f,
    );
  }
  for (const l of args.figures.backlog.filter((x) => on(x.key))) {
    zebra(
      figuresSheet.addRow({
        block: "Still outstanding",
        figure: l.label,
        value: l.display ?? l.value,
      }),
      ++f,
    );
  }

  // ---- Sheet 2: the rows behind them ----------------------------------------
  const sheet = workbook.addWorksheet(DETAIL_SHEET_NAME, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: "Action", key: "action", width: 24 },
    { header: "Item", key: "item", width: 34 },
    { header: "Detail", key: "detail", width: 26 },
    { header: "City", key: "city", width: 18 },
    { header: "State", key: "state", width: 18 },
    { header: "Source", key: "source", width: 14 },
    { header: "When (IST)", key: "at", width: 22 },
    { header: "ID", key: "id", width: 38 },
  ];
  styleHeader(sheet.getRow(1));

  // Bucket order follows the mail's row order, so somebody reading both sees the
  // same story twice rather than having to re-map it.
  let i = 0;
  for (const line of args.figures.activity) {
    if (!line.bucket || line.indent || !on(line.key)) continue;
    for (const row of args.detail[line.bucket] ?? []) {
      zebra(
        sheet.addRow({
          action: line.label,
          item: row.title,
          detail: row.subtitle ?? "—",
          city: row.city ?? "—",
          state: row.state ?? "—",
          source: row.source ?? "—",
          at: fmtIst(row.at),
          id: row.id,
        }),
        ++i,
      );
    }
  }

  // A day where nothing happened still gets a sheet, with a line saying so — an
  // empty grid reads as a broken export rather than a quiet Tuesday.
  if (i === 0) {
    zebra(
      sheet.addRow({
        action: "—",
        item: `No ${args.kind.label} activity on ${args.istDay}`,
        detail: "—",
        city: "—",
        state: "—",
        source: "—",
        at: "—",
        id: "—",
      }),
      1,
    );
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: DETAIL_COLUMNS.length },
  };

  return workbook;
}

/** Distinct `sheet` names across a digest's lines, in first-seen order. */
export function namedSheets(figures: DigestFigures): string[] {
  const out: string[] = [];
  for (const l of [...figures.activity, ...figures.backlog]) {
    if (l.sheet && !out.includes(l.sheet)) out.push(l.sheet);
  }
  return out;
}

/**
 * One grid block on its own sheet, exactly as the mail shows it: title, the
 * note under it, the header row, the rows (group headers bold), then the
 * block's footer box ("Right now") when that section is on.
 */
function writeTableSheet(
  workbook: ExcelJS.Workbook,
  t: DigestTable,
  istDay: string,
  used: Set<string>,
  on: (key: string) => boolean,
): void {
  let name = safeSheetName(t.title);
  for (let n = 2; used.has(name); n++) name = safeSheetName(`${t.title.slice(0, 27)} ${n}`);
  used.add(name);

  const ws = workbook.addWorksheet(name);
  ws.columns = t.columns.map((_, i) => ({ width: i === 0 ? 34 : i < (t.textColumns ?? 2) ? 22 : 16 }));

  ws.addRow([t.title, istDay]).font = { bold: true, size: 12 };
  if (t.note) ws.addRow([t.note]).font = { italic: true, color: { argb: "FF64748B" } };
  ws.addRow([]);
  const header = ws.addRow([...t.columns]);
  styleHeader(header);
  ws.views = [{ state: "frozen", ySplit: header.number }];

  if (t.rows.length === 0) {
    ws.addRow([t.empty ?? "Nothing to show."]);
  }
  let i = 0;
  for (const r of t.rows) {
    const isGroup = !!t.groupHeaders && r.slice(1).every((c) => c === "" || c == null);
    const row = ws.addRow(r);
    if (isGroup) row.font = { bold: true };
    else zebra(row, ++i);
  }

  if (t.footer && on(t.footer.key)) {
    ws.addRow([]);
    ws.addRow([t.footer.label]).font = { bold: true };
    for (const it of t.footer.items) ws.addRow([it.label, it.value, it.hint ?? ""]);
  }
}

/** Excel caps sheet names at 31 chars and forbids : \ / ? * [ ] */
function safeSheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, "-").slice(0, 31);
}

/**
 * One flow on one worksheet: its figures (day + still outstanding), a blank
 * row, then the rows behind its bucketed lines under their own header band.
 */
function writeFlowSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  args: {
    kind: DigestKindDescriptor;
    istDay: string;
    figures: DigestFigures;
    detail: DigestDetail;
  },
  on: (key: string) => boolean,
): void {
  const ws = workbook.addWorksheet(safeSheetName(name), {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  ws.columns = [
    { key: "c1", width: 30 },
    { key: "c2", width: 40 },
    { key: "c3", width: 30 },
    { key: "c4", width: 18 },
    { key: "c5", width: 18 },
    { key: "c6", width: 16 },
    { key: "c7", width: 22 },
    { key: "c8", width: 38 },
  ];

  styleHeader(ws.addRow([...FIGURES_COLUMNS]));

  let f = 0;
  const activity = args.figures.activity.filter((l) => l.sheet === name && on(l.key));
  for (const l of activity) {
    zebra(
      ws.addRow([args.istDay, (l.indent ? "    " : "") + l.label, l.display ?? l.value]),
      ++f,
    );
  }
  for (const l of args.figures.backlog.filter((x) => x.sheet === name && on(x.key))) {
    zebra(ws.addRow(["Still outstanding", l.label, l.display ?? l.value]), ++f);
  }

  ws.addRow([]);
  styleHeader(ws.addRow([...DETAIL_COLUMNS]));

  let i = 0;
  for (const line of activity) {
    if (!line.bucket || line.indent) continue;
    for (const row of args.detail[line.bucket] ?? []) {
      zebra(
        ws.addRow([
          line.label,
          row.title,
          row.subtitle ?? "—",
          row.city ?? "—",
          row.state ?? "—",
          row.source ?? "—",
          fmtIst(row.at),
          row.id,
        ]),
        ++i,
      );
    }
  }
  if (i === 0) {
    zebra(
      ws.addRow(["—", `No ${name} activity on ${args.istDay}`, "—", "—", "—", "—", "—", "—"]),
      1,
    );
  }
}

/** The bytes, ready for a MailAttachment `content`. */
export async function buildDigestXlsx(args: {
  kind: DigestKindDescriptor;
  istDay: string;
  figures: DigestFigures;
  detail: DigestDetail;
  sections?: DigestSections;
}): Promise<Buffer> {
  const workbook = await buildDigestWorkbook(args);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
