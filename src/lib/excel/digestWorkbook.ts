/**
 * The .xlsx a scheduled digest can attach (E-285, generalised by E-286).
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
