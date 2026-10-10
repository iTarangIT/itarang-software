import { describe, expect, it } from "vitest";
import {
  baseValueMismatch,
  buildBaseValueRefs,
  distinctInvoiceNumbers,
} from "../invoice-rules";

const row = (invoice_number: string, model_id: string, base_value: unknown) => ({
  invoice_number,
  model_id,
  base_value,
});

// Shape of the "Hakim Ali" sheet from iTarang Dealers Master Serial No. Data.xlsx
const sheet = [
  row("ITG/202526/1", "TKLiEV-51105-IOT", 39167),
  row("ITG/202526/1", "TKLiEV-51105-IOT", 39167),
  row("ITG/202526/25", "TKLiEV-64105-IOT", 50486),
  row("ITG/202627/005", "TKLiEV-51105-IOT", 40158.5),
  row("ITG/202627/005", "TKLiEV-64105-IOT", 51815),
  row("ITG/202627/036", "TKLiEV-51105-IOT", 48500),
  row("ITG/202627/036", "TKLiEV-51105-Non IoT", 43500),
  row("ITG/202627/036", "TKLiEV-51105-Non IoT", "43500"),
];

describe("inventory invoice rules", () => {
  it("allows several invoices in one file", () => {
    expect(distinctInvoiceNumbers(sheet)).toEqual([
      "ITG/202526/1",
      "ITG/202526/25",
      "ITG/202627/005",
      "ITG/202627/036",
    ]);
  });

  it("accepts a multi-invoice, multi-model sheet with consistent prices", () => {
    const refs = buildBaseValueRefs(sheet, "battery");
    for (const r of sheet) expect(baseValueMismatch(r, "battery", refs)).toBeNull();
  });

  it("lets the same model differ in price across invoices", () => {
    const rows = [row("A", "M1", 100), row("B", "M1", 200)];
    const refs = buildBaseValueRefs(rows, "battery");
    expect(baseValueMismatch(rows[1], "battery", refs)).toBeNull();
  });

  it("rejects a price change for the same model on the same invoice", () => {
    const rows = [row("A", "M1", 100), row("A", "m1 ", 150)];
    const refs = buildBaseValueRefs(rows, "battery");
    expect(baseValueMismatch(rows[1], "battery", refs)).toMatchObject({
      value: 100,
      invoiceNumber: "A",
    });
  });

  it("skips the base_value check for paraphernalia", () => {
    const rows = [
      { invoice_number: "A", item_type_code: "X", base_value: 1 },
      { invoice_number: "A", item_type_code: "X", base_value: 2 },
    ];
    const refs = buildBaseValueRefs(rows, "paraphernalia");
    expect(baseValueMismatch(rows[1], "paraphernalia", refs)).toBeNull();
  });
});
