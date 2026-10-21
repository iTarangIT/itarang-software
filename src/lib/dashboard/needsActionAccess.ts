/**
 * Who may open a "Needs action now" list (src/app/(dashboard)/admin/reports/
 * needs-action/[key]) and its CSV / drill lists — tracker ID 190.
 *
 *   Admin, Sales Head, CEO, partner, Business Head   every list, whole company
 *   anyone else with reporting lines (e.g. an ASM     the "Waiting for a field
 *   who manages other ASMs or ISRs)                   visit" list only, scoped
 *                                                     to their team: themselves
 *                                                     plus their direct reports
 *
 * Everyone else: no access. Server only (reads the reporting lines).
 */
import { getTeamMemberIds } from "@/lib/users/team";

/** The roles that see every list for the whole company. */
export const NEEDS_ACTION_VIEW_ROLES = ["admin", "sales_head", "ceo", "partner", "business_head"] as const;

/** The lists a team manager may open (their team only). */
export const TEAM_MANAGER_KEYS: readonly string[] = ["visit_overdue"];

export type NeedsActionAccess =
    /** Whole company. */
    | { kind: "all" }
    /** A manager: only these people's leads (self + direct reports). */
    | { kind: "team"; teamIds: string[] }
    | { kind: "none" };

export function isNeedsActionViewer(role: string | null | undefined): boolean {
    return (NEEDS_ACTION_VIEW_ROLES as readonly string[]).includes(String(role ?? "").toLowerCase());
}

/** The viewer's access to list `key` (an ActionKey, or "fv" for the field-visit drill kinds). */
export async function needsActionAccess(user: { id: string; role: string | null | undefined }, key: string): Promise<NeedsActionAccess> {
    if (isNeedsActionViewer(user.role)) return { kind: "all" };
    if (key !== "fv" && !TEAM_MANAGER_KEYS.includes(key)) return { kind: "none" };
    const members = await getTeamMemberIds(user.id);
    if (members.length === 0) return { kind: "none" };
    return { kind: "team", teamIds: [user.id, ...members.filter((m) => m !== user.id)] };
}
