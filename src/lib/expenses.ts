/**
 * Shared expense taxonomy.
 *
 * `EXPENSE_DEPARTMENTS` is the single source of truth for the department list
 * used by the AI invoice tracker — referenced by the AI classification prompt,
 * the admin review form, the API validation, and the CEO dashboard breakdown.
 */

export const EXPENSE_DEPARTMENTS = [
  { value: "ops", label: "Operations" },
  { value: "sales", label: "Sales" },
  { value: "marketing", label: "Marketing" },
  { value: "tech", label: "Tech" },
  { value: "hr", label: "HR" },
  { value: "finance", label: "Finance" },
  { value: "admin", label: "Admin" },
] as const;

export type ExpenseDepartment = (typeof EXPENSE_DEPARTMENTS)[number]["value"];

export const EXPENSE_DEPARTMENT_VALUES = EXPENSE_DEPARTMENTS.map(
  (d) => d.value,
) as [ExpenseDepartment, ...ExpenseDepartment[]];

export function expenseDepartmentLabel(value: string | null | undefined): string {
  if (!value || value === "unassigned") return "Unassigned";
  return EXPENSE_DEPARTMENTS.find((d) => d.value === value)?.label ?? value;
}
