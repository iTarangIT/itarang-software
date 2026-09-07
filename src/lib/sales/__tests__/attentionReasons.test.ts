/**
 * The panel reads `attention_reason` back apart to label each problem. If the
 * scanner's wording drifts and the parser is not taught the new shape, every
 * chip silently collapses to "Needs a look" — the exact wall of undifferentiated
 * amber the redesign removed.
 *
 * So the arithmetic and date cases are pinned by RUNNING validateSalesInvoice
 * rather than by copying its strings: reword a template and this suite fails.
 * The two reasons emitted from driveSalesScan's processFile need Drive and a
 * database to produce, so those stay as literals lifted from the source.
 */
import { describe, expect, it } from "vitest";

import {
  formatAttentionReasons,
  hasAmountConcern,
  parseAttentionReasons,
} from "../attentionReasons";
import {
  formatSalesAttention,
  validateSalesInvoice,
  type SalesInvoiceCandidate,
} from "../validateSalesInvoice";

const candidate = (over: Partial<SalesInvoiceCandidate> = {}): SalesInvoiceCandidate => ({
  invoice_number: "ITD/202627/017",
  invoice_date: "2026-08-18",
  due_date: null,
  customer_name: "EFY Charging Solutions Private Limited",
  customer_gstin: null,
  seller_gstin: "07AAKFI0000A1Z5",
  place_of_supply: null,
  sub_total: 323759,
  tax_total: 58276.62,
  total: 382035.62,
  currency: "INR",
  ...over,
});

/** Run the real validator and join its flags exactly as the scanner stores them. */
function storedReason(
  over: Partial<SalesInvoiceCandidate>,
  folderPath?: string,
): string {
  const result = validateSalesInvoice(candidate(over), { folderPath });
  if (!result.ok) throw new Error(`expected a valid candidate, got: ${result.reason}`);
  const joined = formatSalesAttention(result.attention);
  if (!joined) throw new Error("expected at least one attention flag");
  return joined;
}

describe("parseAttentionReasons", () => {
  it("returns nothing for a clean row", () => {
    expect(parseAttentionReasons(null)).toEqual([]);
    expect(parseAttentionReasons("")).toEqual([]);
    expect(parseAttentionReasons("   ")).toEqual([]);
  });

  it("labels the arithmetic mismatch the validator actually emits", () => {
    const raw = storedReason({ total: 381035.62 });
    const [only] = parseAttentionReasons(raw);

    expect(parseAttentionReasons(raw)).toHaveLength(1);
    expect(only.code).toBe("arithmetic_mismatch");
    expect(only.severity).toBe("amount");
    expect(only.detail).toBe(raw);
  });

  it("keeps 'Sub-total or tax could not be read' apart from the mismatch", () => {
    const raw = storedReason({ sub_total: null });
    const [only] = parseAttentionReasons(raw);

    expect(only.code).toBe("arithmetic_unverifiable");
    expect(only.label).toBe("Total unchecked");
  });

  it("splits three unrelated problems in one stored string", () => {
    // The row from the screenshot: bad arithmetic, a July date in an August
    // folder, and — appended by processFile — disagreeing entity signals.
    const raw =
      storedReason({ total: 381035.62, invoice_date: "2026-07-02" }, "2026/August 2026/Sale/Delhi") +
      " Entity signals disagree (seller GSTIN=ITG, invoice number=ITD, filename=ITD," +
      " folder path=ITD) — recorded as Delhi.";

    const reasons = parseAttentionReasons(raw);

    expect(reasons.map((r) => r.code)).toEqual([
      "arithmetic_mismatch",
      "date_folder_mismatch",
      "entity_conflict",
    ]);
    // Decimals inside the figures must not open a new reason.
    expect(reasons[0].detail).toContain("off by 1000.00");
    expect(reasons[1].detail).toContain("august 2026");
    expect(reasons[2].detail.endsWith("recorded as Delhi.")).toBe(true);
  });

  it("keeps the duplicate warning whole, both of its sentences", () => {
    // Two sentences in ONE reason — the case that rules out splitting on ". ".
    const raw =
      "Possible duplicate of zoho invoice ITG/202526/7 — same customer (HAKIM ALI AUTO" +
      " SALES AND SERVICE), same date and the same ₹34125.00. Confirm before trusting this row.";

    const reasons = parseAttentionReasons(raw);

    expect(reasons).toHaveLength(1);
    expect(reasons[0].code).toBe("possible_duplicate");
    expect(reasons[0].detail).toBe(raw);
  });

  it("treats a missing date as an amount problem, not a filing one", () => {
    // A row with no date is in no date-filtered report, so its value is
    // effectively absent from revenue however correct the total is.
    const [only] = parseAttentionReasons(storedReason({ invoice_date: null }));

    expect(only.code).toBe("missing_date");
    expect(only.severity).toBe("amount");
  });

  it("labels the remaining identity flags", () => {
    const raw = storedReason({
      invoice_number: null,
      customer_name: null,
      seller_gstin: null,
    });

    expect(parseAttentionReasons(raw).map((r) => r.code)).toEqual([
      "missing_number",
      "missing_customer",
      "missing_seller_gstin",
    ]);
  });

  it("labels a non-rupee amount", () => {
    const [first] = parseAttentionReasons(storedReason({ currency: "USD" }));
    expect(first.code).toBe("currency_not_inr");
    expect(first.severity).toBe("amount");
  });

  it("labels the entity reasons processFile appends", () => {
    expect(
      parseAttentionReasons("Could not tell which iTarang entity issued this invoice.")[0].code,
    ).toBe("entity_unknown");
  });

  it("passes wording it does not recognise through unlabelled", () => {
    const reasons = parseAttentionReasons("Something the scanner learned to say later.");

    expect(reasons).toHaveLength(1);
    expect(reasons[0].code).toBe("other");
    expect(reasons[0].detail).toBe("Something the scanner learned to say later.");
  });

  it("keeps unrecognised text that precedes a known reason", () => {
    const reasons = parseAttentionReasons(
      "A future flag lands first. No invoice date could be read.",
    );

    expect(reasons.map((r) => r.code)).toEqual(["other", "missing_date"]);
    expect(reasons[0].detail).toBe("A future flag lands first.");
  });

  it("does not open a reason on words inside another one", () => {
    // "Invoice date" appears mid-sentence here; only a real boundary counts.
    const raw = "Possible duplicate of drive invoice Invoice date 12 — same customer (X), same date and the same ₹10.00. Confirm before trusting this row.";
    expect(parseAttentionReasons(raw)).toHaveLength(1);
  });
});

describe("hasAmountConcern", () => {
  it("separates money problems from untidy filing", () => {
    expect(hasAmountConcern(parseAttentionReasons(storedReason({ total: 381035.62 })))).toBe(true);
    expect(
      hasAmountConcern(
        parseAttentionReasons(storedReason({ invoice_date: "2026-07-02" }, "2026/August 2026/Sale")),
      ),
    ).toBe(false);
  });
});

describe("formatAttentionReasons", () => {
  it("round-trips a stored string", () => {
    const raw = storedReason({ total: 381035.62, invoice_date: null });
    expect(formatAttentionReasons(parseAttentionReasons(raw))).toBe(raw);
  });

  it("rebuilds the remainder when a reason is dropped", () => {
    // What the sub-total backfill does: remove the false arithmetic warning and
    // write back what is left, in the shape the scanner would have written.
    const raw = storedReason({ total: 381035.62, invoice_date: null });
    const kept = parseAttentionReasons(raw).filter((r) => r.code !== "arithmetic_mismatch");

    expect(formatAttentionReasons(kept)).toBe("No invoice date could be read.");
  });

  it("returns null when nothing is left", () => {
    expect(formatAttentionReasons([])).toBeNull();
  });
});
