import { describe, expect, it } from "vitest";

import {
  EXPENSE_BILL_ROLES,
  mayOpenAllExpenseBills,
  mayOpenExpenseBill,
  withAllowedBill,
} from "@/lib/expenses/billAccess";
import { FINANCE_FILE_ROLES } from "@/lib/storage/fileRules";

describe("expense bill rule (ID 166)", () => {
  it("is the same role list the file opener uses for bills", () => {
    expect([...EXPENSE_BILL_ROLES].sort()).toEqual([...FINANCE_FILE_ROLES].sort());
  });

  it("lets Finance, Admin and CEO see every bill, not the Sales Head", () => {
    for (const role of ["admin", "ceo", "finance_controller", "CEO"]) expect(mayOpenAllExpenseBills(role)).toBe(true);
    for (const role of ["sales_head", "business_head", "dealer", "", null]) expect(mayOpenAllExpenseBills(role)).toBe(false);
  });

  it("lets the submitter see their own bill", () => {
    expect(mayOpenExpenseBill({ id: "u-1", role: "sales_head" }, "u-1")).toBe(true);
    expect(mayOpenExpenseBill({ id: "u-1", role: "sales_head" }, "u-2")).toBe(false);
    expect(mayOpenExpenseBill({ id: "u-1", role: "sales_head" }, null)).toBe(false);
    expect(mayOpenExpenseBill({ id: null, role: "sales_head" }, null)).toBe(false);
  });

  it("blanks only the bill link of a row the viewer may not see", () => {
    const row = { id: "e-1", amount: "10", bill_url: "/api/files/documents/expenses/u-2/a.pdf" };
    expect(withAllowedBill(row, "u-2", { id: "u-1", role: "sales_head" })).toEqual({ ...row, bill_url: null });
    expect(withAllowedBill(row, "u-2", { id: "u-1", role: "finance_controller" })).toBe(row);
  });
});
