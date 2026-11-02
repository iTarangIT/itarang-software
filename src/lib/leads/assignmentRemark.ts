// The remark a system (post-AI-call) assignment writes on its touchpoint, and
// the reason pulled back out of it for the "Assigned by AI" badge. Pure — no
// database — so it can be unit-tested and imported anywhere.

/** D8 — remarks of the touchpoint a system (post-AI-call) assignment writes. */
export const SYSTEM_ASSIGNMENT_REMARK = "Assigned after AI call";

/** "Assigned after AI call — Qualified lead, due 3 Nov. Routed to …" → the part after the dash. */
export function aiAssignmentDetail(remarks: string | null | undefined): string | null {
    if (!remarks || !remarks.startsWith(SYSTEM_ASSIGNMENT_REMARK)) return null;
    const rest = remarks.slice(SYSTEM_ASSIGNMENT_REMARK.length).replace(/^\s*[—–-]\s*/, "").trim();
    return rest || null;
}
