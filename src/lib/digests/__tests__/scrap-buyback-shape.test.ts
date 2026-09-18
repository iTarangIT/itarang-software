/**
 * Scrap / Buyback daily digest — the pure line/row shaping.
 */

import { describe, expect, it } from "vitest";

import { buildDigestWorkbook, namedSheets } from "@/lib/excel/digestWorkbook";

import {
  BUYBACK_SHEET,
  SCRAP_SHEET,
  buybackMoveRows,
  buybackSettlementRows,
  inr,
  scrapBuybackFigures,
  scrapConsignmentRows,
  scrapNbfcRows,
  type BuybackDayCounts,
  type ScrapDayCounts,
} from "../kinds/scrap-buyback-shape";
import type { DigestKindDescriptor } from "../types";

const SCRAP: ScrapDayCounts = {
  submitted: 2,
  submitted_batteries: 30,
  submitted_asking: 125000,
  agreed: 1,
  agreed_batteries: 10,
  agreed_amount: 40000,
  paid: 1,
  paid_amount: 38000,
  rejected: 1,
  withdrawn: 0,
  nbfcs_active: 2,
  open_draft: 3,
  open_submitted: 4,
  open_negotiating: 2,
  open_agreed: 1,
  open_agreed_unpaid_amount: 40000,
  open_batteries: 55,
  oldest_open_days: 12,
};

const BUYBACK: BuybackDayCounts = {
  requests: 3,
  requests_web: 2,
  requests_whatsapp: 1,
  requests_csv: 0,
  moved_deals: 2,
  moves: [
    { status: "CLOSED", deals: 1 },
    { status: "VENDOR_AGREED", deals: 1 },
    { status: "SETTLED", deals: 0 },
  ],
  settle_txns: 2,
  received: 60000,
  paid_out: 41000,
  margin_locked: 1900,
  margin_closed: 5000,
  open_by_status: [
    { status: "SUBMITTED", deals: 2, value: 0 },
    { status: "INFO_REQUESTED", deals: 1, value: 0 },
    { status: "PICKED_UP", deals: 1, value: 4100 },
    { status: "DEALER_REOPENED", deals: 5, value: 999 },
  ],
  idle_over_7: 2,
  idle_over_30: 1,
  oldest_idle_days: 45,
};

describe("scrap/buyback figures", () => {
  const figures = scrapBuybackFigures(SCRAP, BUYBACK);
  const all = [...figures.activity, ...figures.backlog];

  it("gives every line a unique label (counts blob is keyed by label)", () => {
    const labels = all.map((l) => l.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("puts every line on exactly one of the two flow sheets, never mixed", () => {
    for (const l of all) {
      expect([SCRAP_SHEET, BUYBACK_SHEET]).toContain(l.sheet);
      if (l.sheet === SCRAP_SHEET) expect(l.label.startsWith("Scrap")).toBe(true);
      if (l.sheet === BUYBACK_SHEET) expect(l.label.startsWith("Buyback")).toBe(true);
    }
    expect(namedSheets(figures)).toEqual([SCRAP_SHEET, BUYBACK_SHEET]);
  });

  it("formats rupee lines but keeps the raw value", () => {
    const asking = figures.activity.find((l) => l.label === "Scrap · asking amount")!;
    expect(asking.value).toBe(125000);
    expect(asking.display).toBe("₹1,25,000");
    expect(inr("41000.50")).toBe("₹41,001");
  });

  it("lists status moves in pipeline order and drops zero moves", () => {
    const moves = figures.activity.filter((l) => l.key === "buybackMoves" && l.indent);
    expect(moves.map((l) => l.label)).toEqual([
      "Buyback · moved to Vendor agreed",
      "Buyback · moved to Closed",
    ]);
  });

  it("folds open deals into the dashboard's stages, dropping off-stage statuses", () => {
    const stage = (label: string) =>
      figures.backlog.find((l) => l.label === `Buyback open · ${label}`)!.value;
    expect(stage("Submitted")).toBe(3);
    expect(stage("Picked")).toBe(1);
    expect(stage("Reviewed")).toBe(0);
    const value = figures.backlog.find((l) => l.label.includes("value at stake"))!;
    expect(value.value).toBe(4100);
  });

  it("says 'none open' rather than 0 days when nothing is open", () => {
    const f = scrapBuybackFigures({ ...SCRAP, oldest_open_days: null }, BUYBACK);
    expect(f.backlog.find((l) => l.label === "Scrap · oldest open consignment")!.display).toBe(
      "none open",
    );
  });
});

describe("scrap/buyback detail rows", () => {
  it("shapes a consignment", () => {
    const [r] = scrapConsignmentRows(
      [{ id: "c1", ref_code: "SC-1", nbfc: "Acme", battery_count: 12, amount: "50000", city: "Pune", state: null, at: "2026-09-16T05:00:00Z" }],
      "asking",
    );
    expect(r).toEqual({
      id: "c1",
      title: "SC-1",
      subtitle: "Acme · 12 batteries · asking ₹50,000",
      city: "Pune",
      state: null,
      source: "Acme",
      at: "2026-09-16T05:00:00Z",
    });
  });

  it("summarises one NBFC per row", () => {
    const [r] = scrapNbfcRows([
      { tenant_id: "t1", nbfc: "Acme", submitted: 2, batteries: 30, asking: 125000, agreed: 1, agreed_amount: 40000, paid: 0, paid_amount: 0, rejected: 0, withdrawn: 1 },
    ]);
    expect(r.title).toBe("Acme");
    expect(r.subtitle).toBe(
      "submitted 2 (30 batteries, asking ₹1,25,000) · agreed 1 (₹40,000) · paid 0 (₹0) · rejected 0 · withdrawn 1",
    );
  });

  it("describes a move and a settlement", () => {
    expect(
      buybackMoveRows([{ deal_id: "d1", request_no: "BB-1", dealer: "D", from_status: "PICKED_UP", to_status: "INVOICE_RAISED", role: "admin" }])[0].subtitle,
    ).toBe("D · Picked up → Invoice raised");
    expect(
      buybackSettlementRows([{ id: "s1", request_no: "BB-1", dealer: "D", leg: "VENDOR", direction: "IN", amount: 6000, method: "MANUAL" }])[0].subtitle,
    ).toBe("D · VENDOR received ₹6,000");
    expect(scrapConsignmentRows(null, "x")).toEqual([]);
  });
});

describe("scrap/buyback workbook", () => {
  it("writes one worksheet per flow instead of the shared Figures/Detail pair", async () => {
    const wb = await buildDigestWorkbook({
      kind: { id: "scrap_buyback_daily", label: "Scrap / Buyback" } as unknown as DigestKindDescriptor,
      istDay: "2026-09-16",
      figures: scrapBuybackFigures(SCRAP, BUYBACK),
      detail: {
        scrapSubmitted: scrapConsignmentRows([{ id: "c1", ref_code: "SC-1", nbfc: "Acme", battery_count: 1 }], "asking"),
      },
    });
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual([SCRAP_SHEET, BUYBACK_SHEET]);

    const scrap = wb.getWorksheet(SCRAP_SHEET)!;
    const text: string[] = [];
    scrap.eachRow((row) => text.push(String(row.getCell(2).value ?? "")));
    expect(text.some((t) => t.includes("SC-1"))).toBe(true);
    expect(text.some((t) => t.startsWith("Buyback"))).toBe(false);

    const buyback = wb.getWorksheet(BUYBACK_SHEET)!;
    const bText: string[] = [];
    buyback.eachRow((row) => bText.push(String(row.getCell(2).value ?? "")));
    expect(bText.some((t) => t.includes("No Dealer Buyback activity"))).toBe(true);
    expect(bText.some((t) => t.startsWith("Scrap"))).toBe(false);
  });
});
