import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

/**
 * "Who approved this dealer" tag for the Dealer Validation console.
 *
 * `dealer_onboarding_applications.approved_by` holds the approver's users.id
 * (written by the approve route). The tag is derived from that user's role:
 *   ceo        → "CEO approved"
 *   everything else (sales_head / admin) → "Admin approved"
 * Rows approved before approved_by was recorded get no tag (null).
 */
export type ApprovalTag = "CEO approved" | "Admin approved";

export function approvalTagForRole(role: string | null | undefined): ApprovalTag {
  return (role || "").toLowerCase() === "ceo" ? "CEO approved" : "Admin approved";
}

/** Resolve approver ids → tag in one query. Unknown ids map to null. */
export async function approvalTagsFor(
  approverIds: Array<string | null | undefined>,
): Promise<Map<string, ApprovalTag>> {
  const ids = Array.from(new Set(approverIds.filter((x): x is string => !!x)));
  const out = new Map<string, ApprovalTag>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(inArray(users.id, ids));
  for (const r of rows) out.set(r.id, approvalTagForRole(r.role));
  return out;
}
