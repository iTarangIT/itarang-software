/**
 * Shared expense taxonomy.
 *
 * `EXPENSE_DEPARTMENTS` is the single source of truth for the department list
 * used by the AI invoice tracker — referenced by the AI classification prompt,
 * the admin review form, the API validation, and the CEO dashboard breakdown.
 *
 * `EXPENSE_BUCKETS` (E-218) is the coarser layer above it: four groupings the
 * CEO reads at a glance. Department answers "whose budget is this?"; bucket
 * answers "what kind of spend is this?" — a Trontek battery order and an AWS
 * bill can both sit under Tech as a department while being RM Purchase and
 * Tech spend respectively.
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

/**
 * Synthetic key for a NULL department, mirroring UNCLASSIFIED_BUCKET_KEY below.
 *
 * It exists so a row with no department is still *filterable*: the drill-down
 * sends this value back and the route turns it into `department IS NULL`.
 * Without a name for the empty case, those rows could only be reached by not
 * filtering at all.
 */
export const UNASSIGNED_DEPARTMENT_KEY = "unassigned";

export function expenseDepartmentLabel(value: string | null | undefined): string {
  if (!value || value === UNASSIGNED_DEPARTMENT_KEY) return "Unassigned";
  return EXPENSE_DEPARTMENTS.find((d) => d.value === value)?.label ?? value;
}

// ---------------------------------------------------------------------------
// E-218 — spend buckets
// ---------------------------------------------------------------------------

export const EXPENSE_BUCKETS = [
  { value: "tech", label: "Tech" },
  { value: "rm", label: "RM Purchase" },
  { value: "misc", label: "Miscellaneous" },
  { value: "others", label: "Others" },
] as const;

export type ExpenseBucket = (typeof EXPENSE_BUCKETS)[number]["value"];

export const EXPENSE_BUCKET_VALUES = EXPENSE_BUCKETS.map((b) => b.value) as [
  ExpenseBucket,
  ...ExpenseBucket[],
];

/**
 * The bucket a row falls back to when nothing else identifies it. Deliberately
 * a real bucket rather than NULL: an unclassifiable expense is still spend, and
 * leaving it out of the four tiles would make them fail to sum to the total.
 */
export const DEFAULT_EXPENSE_BUCKET: ExpenseBucket = "others";

/** What each bucket covers — shown as tile help text and fed to the classifier. */
export const EXPENSE_BUCKET_DESCRIPTIONS: Record<ExpenseBucket, string> = {
  tech: "Software, SaaS subscriptions, cloud and hosting, IT hardware, developer and AI tooling.",
  rm: "Raw material and components bought to build or service the product — cells, batteries, chargers, wiring harnesses, motors, controllers.",
  misc: "Running the business — travel, office, rent, utilities, freight, professional fees, statutory payments, marketing.",
  others: "Anything that does not clearly belong to the three above.",
};

/**
 * One colour per bucket, used by the tiles, the stacked bar chart and its
 * legend. They share this map so the three can never disagree about which
 * colour means which bucket. Values are the brand tokens from globals.css.
 */
export const EXPENSE_BUCKET_COLORS: Record<ExpenseBucket, string> = {
  tech: "#138fc6", // brand-sky
  rm: "#2e68b2", // brand-royal
  misc: "#b45309", // warning
  others: "#5a6877", // ink-muted
};

/**
 * The key a NULL bucket is reported under by the dashboard API.
 *
 * Deliberately NOT folded into "others": `others` means the classifier looked
 * and found nothing that fit, whereas NULL means the row predates E-218 and has
 * never been looked at. Merging them would make an unrun backfill look like a
 * genuine finding. It is a reporting key, not a bucket — nothing writes it to
 * the column.
 */
export const UNCLASSIFIED_BUCKET_KEY = "unclassified";

/** Lighter than any real bucket, so a bar full of it reads as "not done yet". */
export const UNCLASSIFIED_BUCKET_COLOR = "#c2c9d1";

export function expenseBucketLabel(value: string | null | undefined): string {
  if (!value || value === UNCLASSIFIED_BUCKET_KEY) return "Unclassified";
  return EXPENSE_BUCKETS.find((b) => b.value === value)?.label ?? value;
}

/** Colour for a bucket key, including the synthetic "unclassified" one. */
export function expenseBucketColor(value: string | null | undefined): string {
  if (isExpenseBucket(value)) return EXPENSE_BUCKET_COLORS[value];
  return UNCLASSIFIED_BUCKET_COLOR;
}

export function isExpenseBucket(value: unknown): value is ExpenseBucket {
  return (
    typeof value === "string" &&
    EXPENSE_BUCKET_VALUES.includes(value as ExpenseBucket)
  );
}
