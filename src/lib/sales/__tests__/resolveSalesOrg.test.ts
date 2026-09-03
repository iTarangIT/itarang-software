import { describe, expect, it } from "vitest";
import {
  ORG_DELHI,
  ORG_HARYANA,
  resolveSalesOrg,
} from "@/lib/sales/resolveSalesOrg";

describe("resolveSalesOrg", () => {
  it("reads the entity off a real Delhi invoice", () => {
    const org = resolveSalesOrg({
      sellerGstin: "07AALFI7813E1ZC",
      invoiceNumber: "ITD/202627/013",
      fileName: "ITD_202627_013.pdf",
      folderPath: "2026 / July 2026 / Sales / Delhi",
    });
    expect(org.organizationId).toBe(ORG_DELHI);
    expect(org.code).toBe("ITD");
    expect(org.conflict).toBe(false);
    expect(org.signals).toHaveLength(4);
  });

  it("reads the entity off a real Haryana invoice", () => {
    const org = resolveSalesOrg({
      sellerGstin: "06AALFI7813E1Z8",
      invoiceNumber: "ITG/202627/041",
      fileName: "ITG_202627_41.pdf",
      folderPath: "2026 / August 2026 / Sale / Haryana",
    });
    expect(org.organizationId).toBe(ORG_HARYANA);
    expect(org.code).toBe("ITG");
    expect(org.conflict).toBe(false);
  });

  it("matches the 'Delhi GST' / 'Haryana GST' folder spellings", () => {
    // Both appear in the live tree alongside the plain names.
    expect(
      resolveSalesOrg({ folderPath: "2026 / March 2026 / Sale / Delhi GST" }).code,
    ).toBe("ITD");
    expect(
      resolveSalesOrg({ folderPath: "2026 / April 2026 / Sale / Haryana GST" }).code,
    ).toBe("ITG");
  });

  it("still resolves the 2025 invoices, which have no entity folder or series filename", () => {
    // "2025 / December 2025 / Sales Invoices :: P M MOTORS INVOICE.pdf" —
    // the GSTIN is the only signal these files carry.
    const org = resolveSalesOrg({
      sellerGstin: "07AALFI7813E1ZC",
      invoiceNumber: null,
      fileName: "P M MOTORS INVOICE.pdf",
      folderPath: "2025 / December 2025 / Sales Invoices",
    });
    expect(org.organizationId).toBe(ORG_DELHI);
    expect(org.conflict).toBe(false);
    expect(org.signals).toEqual(["seller GSTIN=ITD"]);
  });

  it("lets the majority win and reports the disagreement", () => {
    // Filed in the wrong folder: three document signals say Haryana, the
    // folder says Delhi. Haryana wins, and the conflict is surfaced.
    const org = resolveSalesOrg({
      sellerGstin: "06AALFI7813E1Z8",
      invoiceNumber: "ITG/202627/041",
      fileName: "ITG_202627_41.pdf",
      folderPath: "2026 / August 2026 / Sale / Delhi",
    });
    expect(org.code).toBe("ITG");
    expect(org.conflict).toBe(true);
  });

  it("breaks a tie on the document rather than on where it was filed", () => {
    // One document signal against one filing signal. The GSTIN is the legal
    // truth; the folder is where somebody put the file.
    const org = resolveSalesOrg({
      sellerGstin: "06AALFI7813E1Z8",
      folderPath: "2026 / August 2026 / Sale / Delhi",
    });
    expect(org.code).toBe("ITG");
    expect(org.conflict).toBe(true);
  });

  it("does not let a customer's address steal the entity vote", () => {
    // A folder named for a customer must not read as the Delhi entity.
    const org = resolveSalesOrg({
      folderPath: "2026 / August 2026 / Sale / New Delhi Motors",
    });
    expect(org.code).toBeNull();
  });

  it("returns nothing rather than guessing when no signal fires", () => {
    const org = resolveSalesOrg({
      sellerGstin: null,
      invoiceNumber: "INV-99",
      fileName: "scan001.pdf",
      folderPath: "2025 / December 2025 / Sales Invoices",
    });
    expect(org.organizationId).toBeNull();
    expect(org.code).toBeNull();
    expect(org.conflict).toBe(false);
    expect(org.signals).toEqual([]);
  });

  it("ignores a GSTIN from a state neither entity is registered in", () => {
    // 27 is Maharashtra — that is the customer's GSTIN, not ours.
    expect(resolveSalesOrg({ sellerGstin: "27AAOCP8906F1Z4" }).code).toBeNull();
  });
});
