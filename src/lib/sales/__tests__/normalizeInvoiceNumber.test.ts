import { describe, expect, it } from "vitest";
import {
  normalizeInvoiceNumber,
  sameInvoiceNumber,
} from "@/lib/sales/normalizeInvoiceNumber";

describe("normalizeInvoiceNumber", () => {
  it("folds the separators the two sources actually use", () => {
    // Observed live: zoho_invoices stores slashes, the Drive filename uses
    // underscores. If these do not collide, the backfill re-imports every
    // Zoho-era invoice and revenue doubles.
    expect(normalizeInvoiceNumber("ITD/202627/013")).toBe("ITD|202627|13");
    expect(normalizeInvoiceNumber("ITD_202627_013")).toBe("ITD|202627|13");
    expect(normalizeInvoiceNumber("ITD-202627-013")).toBe("ITD|202627|13");
    expect(normalizeInvoiceNumber("ITD 202627 013")).toBe("ITD|202627|13");
  });

  it("strips leading zeros so an unpadded filename matches a padded document", () => {
    // The trap this exists for: the file is named ITG_202627_41.pdf but the
    // number printed on the page — and therefore what the model returns — is
    // ITG/202627/041.
    expect(sameInvoiceNumber("ITG_202627_41.pdf", "ITG/202627/041")).toBe(true);
  });

  it("keeps genuinely different sequence numbers apart", () => {
    // THE case that matters. Both spellings appear in the same live folder:
    // ITG_202627_035.pdf and ITG_202627_36.pdf are two different invoices, and
    // over-eager normalisation that merged them would silently drop revenue.
    expect(normalizeInvoiceNumber("ITG_202627_035")).toBe("ITG|202627|35");
    expect(normalizeInvoiceNumber("ITG_202627_36")).toBe("ITG|202627|36");
    expect(sameInvoiceNumber("ITG_202627_035", "ITG_202627_36")).toBe(false);
  });

  it("keeps the two entities apart", () => {
    // ITD is Delhi, ITG is Haryana. Same FY, same sequence number, different
    // legal entity and different invoice.
    expect(sameInvoiceNumber("ITD/202627/013", "ITG/202627/013")).toBe(false);
  });

  it("drops a file extension before comparing", () => {
    expect(normalizeInvoiceNumber("ITD_202627_018.pdf")).toBe("ITD|202627|18");
    expect(normalizeInvoiceNumber("ITD_202627_018.PDF")).toBe("ITD|202627|18");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(sameInvoiceNumber("  itd/202627/013  ", "ITD/202627/013")).toBe(true);
  });

  it("returns null when there is nothing to compare", () => {
    // Null means 'cannot dedup by number', so the caller falls back to the
    // amount/date fingerprint. It must never read as a match.
    expect(normalizeInvoiceNumber(null)).toBeNull();
    expect(normalizeInvoiceNumber(undefined)).toBeNull();
    expect(normalizeInvoiceNumber("")).toBeNull();
    expect(normalizeInvoiceNumber("   ")).toBeNull();
    expect(normalizeInvoiceNumber("///")).toBeNull();
    expect(normalizeInvoiceNumber(".pdf")).toBeNull();
  });

  it("never treats two unknowns as the same invoice", () => {
    expect(sameInvoiceNumber(null, null)).toBe(false);
    expect(sameInvoiceNumber("", "")).toBe(false);
    expect(sameInvoiceNumber("ITD/202627/013", null)).toBe(false);
  });

  it("keeps an all-zero segment rather than emptying it", () => {
    expect(normalizeInvoiceNumber("INV/000")).toBe("INV|0");
  });

  it("handles the free-form numbers on the 2025 invoices", () => {
    // Nov/Dec 2025 files are named things like "P M MOTORS INVOICE.pdf" and
    // their printed numbers are not in the ITD/ITG series at all. They must
    // still normalise to something stable rather than throwing.
    expect(normalizeInvoiceNumber("INV-2025-11-07")).toBe("INV|2025|11|7");
    expect(normalizeInvoiceNumber("TI/25-26/104")).toBe("TI|25|26|104");
  });
});
