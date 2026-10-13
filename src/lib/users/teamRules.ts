/**
 * Tracker ID 155 — a manager's team. CLIENT-SAFE, pure (no db import).
 *
 * A manager is anyone with people reporting to them (no new role). Their team
 * is their DIRECT reports on the current, open reporting line (E-338, or
 * users.reports_to before it). The DB side lives in ./team.ts.
 */

/** Owners whose leads `selfId` may read: themself plus their direct reports. */
export function ownerScopeIds(selfId: string, teamMemberIds: readonly string[] | null | undefined): string[] {
    const out = [selfId];
    for (const id of teamMemberIds ?? []) if (id && !out.includes(id)) out.push(id);
    return out;
}

/** Is `ownerId` the viewer themself or one of their direct reports? */
export function ownerInScope(
    ownerId: string | null | undefined,
    selfId: string | null | undefined,
    teamMemberIds: readonly string[] | null | undefined,
): boolean {
    if (!ownerId || !selfId) return false;
    return ownerId === selfId || (teamMemberIds ?? []).includes(ownerId);
}

/**
 * ID 155 / 156: whose numbers a rep's own Performance page shows. A manager
 * may pick a direct report (`?person=`); anything else — no pick, an unknown
 * id, someone outside the team — falls back to the viewer themself, never to
 * an error that would tell them the id exists.
 */
export function pickScopedPerson(
    selfId: string,
    requested: string | null | undefined,
    teamMemberIds: readonly string[] | null | undefined,
): string {
    return requested && (teamMemberIds ?? []).includes(requested) ? requested : selfId;
}

/** ID 156: the `?person=` value meaning "Team total" (the manager + every direct report). */
export const TEAM_TOTAL_PERSON = "team";

/**
 * ID 156: whose numbers the manager's Performance page asks the builder for.
 * `?person=team` with a team → the group (themself + direct reports, the same
 * builder run with an IN-list); a direct report → that one person; anything
 * else → the viewer themself. A team member (no reports) always gets self.
 */
export function pickPerformanceScope(
    selfId: string,
    requested: string | null | undefined,
    teamMemberIds: readonly string[] | null | undefined,
): { spoc_id: string; spoc_ids: null } | { spoc_id: null; spoc_ids: string[] } {
    if (requested === TEAM_TOTAL_PERSON && (teamMemberIds ?? []).length > 0) {
        return { spoc_id: null, spoc_ids: ownerScopeIds(selfId, teamMemberIds) };
    }
    return { spoc_id: pickScopedPerson(selfId, requested, teamMemberIds), spoc_ids: null };
}

export type TeamReassignCheck =
    | { ok: true }
    | { ok: false; reason: "not_manager" | "target_outside_team" | "same_owner"; message: string };

/**
 * ID 155: may `actorId` move a lead owned by `currentOwnerId` to `targetUserId`
 * as that owner's MANAGER? Only between the manager and their own team: the
 * current owner must be a direct report of the actor, and the target must be
 * the actor or another direct report. (A lead the actor owns themself goes
 * through the ordinary owner path, which may hand it to anyone.)
 */
export function checkTeamReassign(input: {
    actorId: string;
    currentOwnerId: string | null | undefined;
    targetUserId: string;
    teamMemberIds: readonly string[];
}): TeamReassignCheck {
    const { actorId, currentOwnerId, targetUserId, teamMemberIds } = input;
    if (!currentOwnerId || currentOwnerId === actorId || !teamMemberIds.includes(currentOwnerId)) {
        return { ok: false, reason: "not_manager", message: "Not the current owner of this lead, or their manager." };
    }
    if (targetUserId === currentOwnerId) {
        return { ok: false, reason: "same_owner", message: "The lead is already with that person." };
    }
    if (targetUserId !== actorId && !teamMemberIds.includes(targetUserId)) {
        return {
            ok: false,
            reason: "target_outside_team",
            message: "As their manager you can move this lead only to yourself or someone in your team.",
        };
    }
    return { ok: true };
}

/**
 * ID 155: a reassign (owner or manager) needs a real reason — at least `min`
 * characters once surrounding whitespace is dropped, so twenty spaces do not
 * pass. Returns the trimmed reason to store, or the message to show.
 */
export function checkReassignReason(
    reason: string | null | undefined,
    min: number,
): { ok: true; reason: string } | { ok: false; message: string } {
    const r = (reason ?? "").trim();
    if (r.length < min) return { ok: false, message: `Give a reason of at least ${min} characters.` };
    return { ok: true, reason: r };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date written YYYY-MM-DD. */
export function isIsoDate(s: string | null | undefined): s is string {
    if (!s || !ISO_DATE.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * ID 155: the start date of a new reporting line. Today or earlier (so the
 * open line and users.reports_to always agree), and not before the current
 * line started (history periods must not overlap). Dates are YYYY-MM-DD, so
 * string order is date order. `today` comes from Postgres, never the Node
 * clock.
 */
export function checkLineStart(input: {
    start: string;
    today: string;
    openFrom: string | null | undefined;
}): { ok: true } | { ok: false; message: string } {
    const { start, today, openFrom } = input;
    if (!isIsoDate(start)) return { ok: false, message: "Pick a valid start date." };
    if (start > today) return { ok: false, message: "The start date cannot be in the future." };
    if (openFrom && start < openFrom) {
        return { ok: false, message: `The start date cannot be before ${openFrom}, when the current reporting line started.` };
    }
    return { ok: true };
}
