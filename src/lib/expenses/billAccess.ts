// Who may see expense bills (tracker ID 166, decided 10 Oct): Finance, Admin,
// the CEO, and the person who submitted the expense. The Sales Head does NOT —
// although the AI expense tracker otherwise treats sales_head as an admin
// (requireApiAdmin), the bills themselves follow this rule.
//
// Same role list as FINANCE_FILE_ROLES in src/lib/storage/fileRules.ts, which
// decides when the stored file is opened; a test pins the two together. Pure:
// no db or env imports.

export const EXPENSE_BILL_ROLES = ["admin", "ceo", "finance_controller"] as const;

/** May this role see EVERY expense bill (and download the bills ZIP)? */
export function mayOpenAllExpenseBills(role: string | null | undefined): boolean {
  return (EXPENSE_BILL_ROLES as readonly string[]).includes((role ?? "").toLowerCase());
}

/** May this viewer see the bill of an expense submitted by `submitterId`? */
export function mayOpenExpenseBill(
  viewer: { id: string | null | undefined; role: string | null | undefined },
  submitterId: string | null | undefined,
): boolean {
  if (mayOpenAllExpenseBills(viewer.role)) return true;
  return !!viewer.id && !!submitterId && viewer.id === submitterId;
}

/**
 * A list row with its bill link blanked when this viewer may not see it. The
 * rest of the row (amount, vendor, …) is left alone: who may LIST expenses is
 * the route's own decision.
 */
export function withAllowedBill<T extends { bill_url: string | null }>(
  row: T,
  submitterId: string | null | undefined,
  viewer: { id: string | null | undefined; role: string | null | undefined },
): T {
  return mayOpenExpenseBill(viewer, submitterId) ? row : { ...row, bill_url: null };
}
