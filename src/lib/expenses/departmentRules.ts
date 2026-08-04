/**
 * E-224 — deterministic department rules.
 *
 * WHY THIS EXISTS
 *   E-218 drew a clean line between the two axes: department answers "whose
 *   budget is this?", bucket answers "what kind of spend is this?". The line is
 *   right. What was wrong was the worked example both classifier prompts used to
 *   teach it —
 *
 *       "a battery order raised by the tech team is department tech but bucket rm"
 *
 *   — which told the model, on every single invoice, that raw material can sit
 *   on the Tech budget. It duly filed the Trontek cell orders under Tech, and
 *   the CEO's by-department strip read ₹38.42L of "Tech" against ₹75K of
 *   Operations. Tech was not spending that money; production was.
 *
 * THE RULE
 *   Raw material and components are Operations spend. The Tech department is
 *   software, SaaS, cloud and IT — the things a tech budget actually buys.
 *   Stated as an invariant the data can be checked against:
 *
 *       bucket = 'rm'  ⇒  department ≠ 'tech'
 *
 * WHY RULES RATHER THAN A BETTER PROMPT
 *   Same reason bucketRules.ts exists (see its header). A rule is free, never
 *   drifts between two runs of the same invoice, and — crucially — a backfill
 *   can apply it to the rows already in the table. Re-prompting fixes nothing
 *   retroactively, and a department that flips between scans makes the
 *   month-on-month comparison lie.
 *
 *   The prompts were fixed too. This is the belt to that pair of braces.
 */
import {
  EXPENSE_DEPARTMENT_VALUES,
  type ExpenseBucket,
  type ExpenseDepartment,
} from "@/lib/expenses";

/** Where an unclassifiable expense lands. Matches validateExpense's fallback. */
export const DEFAULT_EXPENSE_DEPARTMENT: ExpenseDepartment = "ops";

/** The department that runs production and procurement. */
export const RM_DEPARTMENT: ExpenseDepartment = "ops";

export interface DepartmentRuleInput {
  vendor?: string | null;
  description?: string | null;
  project_tag?: string | null;
  /** The resolved bucket, when one is already known. */
  bucket?: ExpenseBucket | string | null;
}

export interface DepartmentRuleMatch {
  department: ExpenseDepartment;
  /** Which rule fired — for the backfill report and for debugging a wrong call. */
  rule: string;
}

/**
 * Vendor fragments whose spend belongs to a specific budget regardless of what
 * the model decided. Matched as a substring of the normalised vendor name, so
 * "Trontek Electronics Limited" and "TRONTEK" both hit.
 *
 * Deliberately short. It lists only the cases the model gets WRONG — the
 * component suppliers it kept filing under Tech. A vendor the model already
 * classifies correctly does not need a line here, and every line here is a
 * judgement that has to stay true.
 */
export const VENDOR_DEPARTMENT_RULES: ReadonlyArray<
  readonly [fragment: string, department: ExpenseDepartment]
> = [
  // Cell, battery and component suppliers — production's budget, not Tech's.
  ["trontek", RM_DEPARTMENT],
  ["ecostar", RM_DEPARTMENT],
  ["ampfusion", RM_DEPARTMENT],
  ["amp fusion", RM_DEPARTMENT],
  ["ayansh", RM_DEPARTMENT],
  ["exide", RM_DEPARTMENT],
  ["amaron", RM_DEPARTMENT],
  ["livguard", RM_DEPARTMENT],
  ["okaya", RM_DEPARTMENT],
  ["lohum", RM_DEPARTMENT],
  ["trinity electric", RM_DEPARTMENT],
  ["aradhya", RM_DEPARTMENT],
];

function normalise(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function isExpenseDepartment(value: unknown): value is ExpenseDepartment {
  return (
    typeof value === "string" &&
    EXPENSE_DEPARTMENT_VALUES.includes(value as ExpenseDepartment)
  );
}

/**
 * Decide a department from what is already known, without a model call.
 *
 * Returns `null` when no rule applies — the signal to keep the model's answer,
 * not an error. The rules are deliberately narrow: they correct the one class of
 * mistake that was distorting the dashboard and stay out of the way otherwise.
 */
export function departmentFromRules(
  input: DepartmentRuleInput,
): DepartmentRuleMatch | null {
  const vendor = normalise(input.vendor);
  if (vendor) {
    for (const [fragment, department] of VENDOR_DEPARTMENT_RULES) {
      if (vendor.includes(fragment)) {
        return { department, rule: `vendor:${fragment}` };
      }
    }
  }

  // The invariant. Note it only fires for `rm` — it does NOT claim the reverse
  // (bucket 'tech' ⇒ department 'tech'), because a Canva subscription bought by
  // marketing is genuinely marketing's budget and tech spend. Only the
  // raw-material direction was producing a wrong number.
  if (normalise(String(input.bucket ?? "")) === "rm") {
    return { department: RM_DEPARTMENT, rule: "bucket:rm" };
  }

  return null;
}

export interface ResolveDepartmentInput extends DepartmentRuleInput {
  /** What the extractor returned, if anything. */
  aiDepartment?: string | null;
  aiConfidence?: number | null;
}

/** Who decided the department. Mirrors BucketSource. */
export type DepartmentSource = "rule" | "ai" | "default";

export interface ResolvedDepartment {
  department: ExpenseDepartment;
  source: DepartmentSource;
  /** Which rule fired, or why the model's answer was not used. Null when trivial. */
  detail: string | null;
}

/**
 * Below this the model is guessing. Same floor as MIN_DEPARTMENT_CONFIDENCE in
 * validateExpense.ts and MIN_BUCKET_CONFIDENCE in resolveBucket.ts.
 */
export const MIN_DEPARTMENT_CONFIDENCE = 0.5;

/**
 * The single place a department is decided, mirroring resolveBucket().
 *
 * Precedence, highest first:
 *   1. Rules   — a named vendor, or the bucket='rm' invariant. Never drifts.
 *   2. Model   — only if it whitelists AND clears the confidence floor.
 *   3. Default — "ops", so a row always has a department to be grouped under.
 */
export function resolveDepartment(
  input: ResolveDepartmentInput,
): ResolvedDepartment {
  const ruled = departmentFromRules(input);
  if (ruled) {
    return { department: ruled.department, source: "rule", detail: ruled.rule };
  }

  const { aiDepartment, aiConfidence } = input;
  if (isExpenseDepartment(aiDepartment)) {
    if (
      typeof aiConfidence === "number" &&
      Number.isFinite(aiConfidence) &&
      aiConfidence < MIN_DEPARTMENT_CONFIDENCE
    ) {
      return {
        department: DEFAULT_EXPENSE_DEPARTMENT,
        source: "default",
        detail: `model suggested "${aiDepartment}" at ${Math.round(
          aiConfidence * 100,
        )}% — below the ${Math.round(MIN_DEPARTMENT_CONFIDENCE * 100)}% floor`,
      };
    }
    return { department: aiDepartment, source: "ai", detail: null };
  }

  return {
    department: DEFAULT_EXPENSE_DEPARTMENT,
    source: "default",
    detail: "no rule matched and no usable classification",
  };
}
