/**
 * E-285/E-286 — the .xlsx a digest attaches.
 *
 * Pure: builds a real workbook in memory and reads it back. No database, no
 * mail, no HTTP — the builder was deliberately split out of any route so this is
 * possible (see the module header).
 */

import { describe, expect, it } from "vitest";

import {
  DETAIL_COLUMNS,
  DETAIL_SHEET_NAME,
  FIGURES_COLUMNS,
  FIGURES_SHEET_NAME,
  XLSX_CONTENT_TYPE,
  buildDigestWorkbook,
  buildDigestXlsx,
  digestWorkbookFilename,
} from "../digestWorkbook";
import type {
  DigestDetail,
  DigestFigures,
  DigestKindDescriptor,
} from "@/lib/digests/types";

const KIND = {
  id: "kyc_review",
  label: "KYC Review",
  ctaHref: "/admin/kyc-review",
  ctaLabel: "Open KYC Review",
} as unknown as DigestKindDescriptor;

const row = (id: string, title: string, at: string) => ({
  id,
  title,
  subtitle: "Dealer " + id,
  city: "Nashik",
  state: "Maharashtra",
  source: "admin",
  at,
});

const FIGURES: DigestFigures = {
  activity: [
    { key: "approved", label: "Approved", value: 2, bucket: "approved" },
    { key: "approved", label: "by a person", value: 1, indent: true },
    { key: "approved", label: "automatic (SLA)", value: 1, indent: true },
    { key: "rejected", label: "Rejected", value: 1, bucket: "rejected" },
  ],
  backlog: [
    { key: "backlog", label: "Waiting for review", value: 7 },
    { key: "ageing", label: "Oldest case waiting", value: 129, display: "129 days" },
  ],
};

const DETAIL: DigestDetail = {
  approved: [
    row("a1", "ALPHA", "2026-08-27T02:50:10.012Z"),
    row("a2", "BETA", "2026-08-27T03:00:00.000Z"),
  ],
  rejected: [row("r1", "GAMMA", "2026-08-27T04:00:00.000Z")],
};

const EMPTY_FIGURES: DigestFigures = { activity: [], backlog: [] };

describe("digest workbook", () => {
  it("writes both sheets with the documented headers", async () => {
    const wb = await buildDigestWorkbook({
      kind: KIND,
      istDay: "2026-08-27",
      figures: FIGURES,
      detail: DETAIL,
    });

    const figures = wb.getWorksheet(FIGURES_SHEET_NAME);
    const detail = wb.getWorksheet(DETAIL_SHEET_NAME);
    expect(figures, "the figures sheet name changed").toBeDefined();
    expect(detail, "the detail sheet name changed").toBeDefined();

    expect((figures!.getRow(1).values as unknown[]).slice(1)).toEqual([...FIGURES_COLUMNS]);
    expect((detail!.getRow(1).values as unknown[]).slice(1)).toEqual([...DETAIL_COLUMNS]);
  });

  it("records the figures exactly as mailed, indents included", async () => {
    const wb = await buildDigestWorkbook({
      kind: KIND,
      istDay: "2026-08-27",
      figures: FIGURES,
      detail: DETAIL,
    });
    const ws = wb.getWorksheet(FIGURES_SHEET_NAME)!;

    // 1 header + 4 activity + 2 backlog
    expect(ws.rowCount).toBe(7);

    const figureNames: string[] = [];
    ws.eachRow((r, i) => {
      if (i === 1) return;
      figureNames.push(String((r.values as unknown[])[2]));
    });
    expect(figureNames).toContain("Approved");
    expect(figureNames).toContain("    by a person");

    // A `display` figure keeps its human form rather than a bare number.
    const last = ws.getRow(ws.rowCount).values as unknown[];
    expect(String(last[3])).toBe("129 days");
  });

  it("emits one detail row per item, labelled with its bucket", async () => {
    const wb = await buildDigestWorkbook({
      kind: KIND,
      istDay: "2026-08-27",
      figures: FIGURES,
      detail: DETAIL,
    });
    const ws = wb.getWorksheet(DETAIL_SHEET_NAME)!;

    expect(ws.rowCount).toBe(4); // header + 2 approved + 1 rejected

    const actions: string[] = [];
    const items: string[] = [];
    ws.eachRow((r, i) => {
      if (i === 1) return;
      const v = r.values as unknown[];
      actions.push(String(v[1]));
      items.push(String(v[2]));
    });

    // Order mirrors the mail's row order, so the two read the same way.
    expect(actions).toEqual(["Approved", "Approved", "Rejected"]);
    expect(items).toContain("ALPHA");
    expect(items).toContain("GAMMA");
  });

  it("never emits a row for an indented sub-line", async () => {
    // "by a person" has no bucket of its own; its rows belong to "Approved".
    // Emitting them twice would double the sheet against the mail.
    const wb = await buildDigestWorkbook({
      kind: KIND,
      istDay: "2026-08-27",
      figures: FIGURES,
      detail: DETAIL,
    });
    const ws = wb.getWorksheet(DETAIL_SHEET_NAME)!;
    const actions: string[] = [];
    ws.eachRow((r, i) => {
      if (i > 1) actions.push(String((r.values as unknown[])[1]));
    });
    expect(actions).not.toContain("by a person");
  });

  it("omits a bucket whose section the admin switched off", async () => {
    const wb = await buildDigestWorkbook({
      kind: KIND,
      istDay: "2026-08-27",
      figures: FIGURES,
      detail: DETAIL,
      sections: { approved: true, rejected: false, backlog: true, ageing: true },
    });
    const ws = wb.getWorksheet(DETAIL_SHEET_NAME)!;

    const actions: string[] = [];
    ws.eachRow((r, i) => {
      if (i > 1) actions.push(String((r.values as unknown[])[1]));
    });
    expect(actions).toEqual(["Approved", "Approved"]);
    expect(actions).not.toContain("Rejected");
  });

  it("renders timestamps in IST, not UTC", async () => {
    const wb = await buildDigestWorkbook({
      kind: KIND,
      istDay: "2026-08-27",
      // 02:50 UTC is 08:20 IST. A UTC column would read as a decision five and a
      // half hours earlier than it happened.
      figures: {
        activity: [{ key: "approved", label: "Approved", value: 1, bucket: "approved" }],
        backlog: [],
      },
      detail: { approved: [row("a1", "ALPHA", "2026-08-27T02:50:10.012Z")] },
    });
    const when = String((wb.getWorksheet(DETAIL_SHEET_NAME)!.getRow(2).values as unknown[])[7]);

    expect(when).toContain("8:20");
    expect(when).not.toContain("2:50");
  });

  it("says so rather than emitting a bare grid on a quiet day", async () => {
    const wb = await buildDigestWorkbook({
      kind: KIND,
      istDay: "2026-09-06",
      figures: EMPTY_FIGURES,
      detail: {},
    });
    const ws = wb.getWorksheet(DETAIL_SHEET_NAME)!;

    expect(ws.rowCount).toBe(2);
    expect(String((ws.getRow(2).values as unknown[])[2])).toContain(
      "No KYC Review activity on 2026-09-06",
    );
  });

  it("produces bytes that are a real xlsx", async () => {
    const buf = await buildDigestXlsx({
      kind: KIND,
      istDay: "2026-08-27",
      figures: FIGURES,
      detail: DETAIL,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    // xlsx is a zip; "PK" is the local file header magic.
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("names the file after the kind and the day it covers", () => {
    expect(digestWorkbookFilename("kyc_review", "2026-09-06")).toBe(
      "kyc-review-2026-09-06.xlsx",
    );
    expect(digestWorkbookFilename("dealer_validation", "2026-09-06")).toBe(
      "dealer-validation-2026-09-06.xlsx",
    );
  });

  it("declares the MIME type the rest of the repo uses for xlsx", () => {
    expect(XLSX_CONTENT_TYPE).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });
});
