/**
 * Tracker ID 155 — reporting lines. CLIENT-SAFE, pure (no db import).
 *
 * Would setting `userId` to report to `managerId` close a loop? Walks the
 * manager chain upward from `managerId` over the current lines; if it reaches
 * `userId`, the new line makes a cycle (A → B → … → A). A chain that is
 * already broken (a pre-existing loop elsewhere) stops after one pass over the
 * map instead of spinning.
 */
export type ReportingCheck = { ok: true } | { ok: false; reason: "self" | "cycle"; chain: string[] };

export function checkReportingLine(
    userId: string,
    managerId: string | null,
    reportsTo: ReadonlyMap<string, string | null>,
): ReportingCheck {
    if (managerId == null) return { ok: true };
    if (managerId === userId) return { ok: false, reason: "self", chain: [userId] };
    const chain = [userId, managerId];
    const seen = new Set<string>([managerId]);
    let cur: string | null | undefined = reportsTo.get(managerId);
    while (cur != null) {
        chain.push(cur);
        if (cur === userId) return { ok: false, reason: "cycle", chain };
        if (seen.has(cur)) break;
        seen.add(cur);
        cur = reportsTo.get(cur);
    }
    return { ok: true };
}
