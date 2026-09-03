import { describe, expect, it } from "vitest";
import {
  monthFromFolderPath,
  validateSalesInvoice,
  type SalesInvoiceCandidate,
} from "@/lib/sales/validateSalesInvoice";

/** A clean read of the real ITD/202627/013 invoice. */
function candidate(over: Partial<SalesInvoiceCandidate> = {}): SalesInvoiceCandidate {
  return {
    invoice_number: "ITD/202627/013",
    invoice_date: "2026-07-02",
    due_date: "2026-07-02",
    customer_name: "PCAM METALS PRIVATE LIMITED",
    customer_gstin: "06AAOCP8906F1Z4",
    seller_gstin: "07AALFI7813E1ZC",
    place_of_supply: "Haryana (06)",
    sub_total: 25000,
    tax_total: 4500,
    total: 29500,
    currency: "INR",
    ...over,
  };
}

describe("monthFromFolderPath", () => {
  it("finds the month segment in a real Drive path", () => {
    expect(monthFromFolderPath("2026 / August 2026 / Sale / Haryana")).toEqual({
      year: 2026,
      month: 8,
    });
    expect(monthFromFolderPath("2025 / December 2025 / Sales Invoices")).toEqual({
      year: 2025,
      month: 12,
    });
  });

  it("returns null when no segment names a month", () => {
    expect(monthFromFolderPath("2026 / Sale / Delhi")).toBeNull();
    expect(monthFromFolderPath(null)).toBeNull();
    expect(monthFromFolderPath("")).toBeNull();
  });
});

describe("validateSalesInvoice", () => {
  it("accepts a clean invoice with nothing flagged", () => {
    const r = validateSalesInvoice(candidate(), {
      folderPath: "2026 / July 2026 / Sales / Delhi",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attention).toEqual([]);
    expect(r.value.total).toBe(29500);
    expect(r.value.customer_name).toBe("PCAM METALS PRIVATE LIMITED");
  });

  it("refuses a row with no readable total", () => {
    // expense_submissions' equivalent rule: a zero would silently understate
    // the number, which is worse than an absent row that is reported.
    const r = validateSalesInvoice(candidate({ total: null }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/No total/i);
  });

  it("refuses a non-positive total", () => {
    expect(validateSalesInvoice(candidate({ total: 0 })).ok).toBe(false);
    expect(validateSalesInvoice(candidate({ total: -100 })).ok).toBe(false);
  });

  it("flags the year misread the Step-0 probe actually produced", () => {
    // ITG_202627_41.pdf sits in "August 2026" and came back dated 2023-08-13.
    // Right day, wrong year — invisible without this check.
    const r = validateSalesInvoice(
      candidate({ invoice_date: "2023-08-13" }),
      { folderPath: "2026 / August 2026 / Sale / Haryana" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attention.join(" ")).toMatch(/does not match the folder/i);
    // Still counts toward revenue — flagged, not withheld.
    expect(r.value.total).toBe(29500);
  });

  it("flags arithmetic that does not add up", () => {
    const r = validateSalesInvoice(candidate({ sub_total: 25000, tax_total: 4500, total: 31000 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attention.join(" ")).toMatch(/off by 1500/);
  });

  it("tolerates per-line GST rounding", () => {
    // A multi-line invoice rounds tax per line, so the parts legitimately miss
    // the total by a rupee. That must not read as a misextraction.
    const r = validateSalesInvoice(candidate({ sub_total: 25000, tax_total: 4500, total: 29501 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attention).toEqual([]);
  });

  it("says so when the total could not be cross-checked", () => {
    const r = validateSalesInvoice(candidate({ sub_total: null, tax_total: null }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attention.join(" ")).toMatch(/unchecked/i);
  });

  it("flags a non-INR currency rather than adding it to a rupee total", () => {
    const r = validateSalesInvoice(candidate({ currency: "USD" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attention.join(" ")).toMatch(/not INR/i);
  });

  it("warns that a numberless row cannot be de-duplicated", () => {
    const r = validateSalesInvoice(candidate({ invoice_number: "  " }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.invoice_number).toBeNull();
    expect(r.attention.join(" ")).toMatch(/cannot be de-duplicated/i);
  });

  it("flags missing customer and seller identity", () => {
    const r = validateSalesInvoice(candidate({ customer_name: null, seller_gstin: null }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.attention.join(" ");
    expect(joined).toMatch(/customer name/i);
    expect(joined).toMatch(/seller GSTIN/i);
  });

  it("rejects a malformed date instead of storing it", () => {
    const r = validateSalesInvoice(candidate({ invoice_date: "02-07-2026" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.invoice_date).toBeNull();
    expect(r.attention.join(" ")).toMatch(/No invoice date/i);
  });

  it("skips the month check when the folder does not name a month", () => {
    const r = validateSalesInvoice(candidate(), { folderPath: "Sale / Delhi" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attention).toEqual([]);
  });
});
