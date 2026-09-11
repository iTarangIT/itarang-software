/**
 * Lead Tracking — PURE derivation of ownership episodes and event attribution
 * (E-295). No I/O: src/lib/leads/tracking.ts feeds it rows, the unit tests
 * feed it fixtures.
 *
 * The rules, in order:
 *
 *   1. Episode 0 opens at created_at. Its holder is the pool ("Unassigned") —
 *      unless the FIRST recorded hop says the lead was already owned
 *      (from_owner_id set), in which case episode 0 belongs to that person and
 *      is flagged approximate (we know who, not since when).
 *   2. Every hop closes the open episode and opens a new one held by
 *      to_owner_id. A hop with to_owner_id NULL released the lead to the pool.
 *      A legacy hop (assignment-type touchpoint written before E-295, both
 *      columns NULL) opens an episode held by "Not recorded" — the truth is
 *      unknown and we say so rather than guess.
 *   3. After the hops, if the open episode's holder is not the lead's CURRENT
 *      owner, the record is incomplete (pre-E-295 assignments that never wrote
 *      a hop). A corrective episode for the current owner is appended, starting
 *      at assigned_at (clamped inside the open episode), flagged approximate.
 *   4. The last episode stays open (to_at = null) and counts up to `now`.
 *
 * Events are then attributed to the episode active at their timestamp, and the
 * running lead_status is carried across episode boundaries so each episode
 * knows the status it opened and closed in.
 */

import {
    NOT_RECORDED_PERSON,
    UNASSIGNED_PERSON,
    type OwnershipEpisode,
    type TrackingEvent,
    type TrackingPerson,
} from "./trackingTypes";

/**
 * Touchpoint types that changed hands before E-295 existed — they are hops
 * even when both owner columns are NULL. Mirrors leadAssignedBy.ts plus the
 * self-assignment and reactivation paths.
 */
export const OWNERSHIP_TOUCHPOINT_TYPES = new Set([
    "lead_assigned",
    "lead_claimed",
    "ownership_transfer",
    "asm_transfer",
    "escalation_resolved_reassign",
    "reactivated_via_admin",
    "reactivated_via_upload",
    "reactivated_via_ai_dialer",
    "onboarding_dropout_action",
]);

export type EpisodeLeadInput = {
    id: string;
    created_at: string;
    assigned_at: string | null;
    updated_at: string | null;
    current_owner_id: string | null;
};

/** One ownership-changing touchpoint, already sorted ascending by `at`. */
export type HopInput = {
    at: string;
    touchpoint_type: string;
    from_owner_id: string | null;
    to_owner_id: string | null;
    /** Whether the columns were actually written (false = legacy, both NULL). */
    recorded: boolean;
    actor: TrackingPerson;
    remarks: string | null;
    label: string;
};

export type ResolvePerson = (id: string | null) => TrackingPerson;

/** Is this touchpoint a hop? Either column written, or a legacy assignment type. */
export function isHop(row: {
    touchpoint_type: string;
    from_owner_id: string | null;
    to_owner_id: string | null;
}): boolean {
    return (
        row.from_owner_id != null ||
        row.to_owner_id != null ||
        OWNERSHIP_TOUCHPOINT_TYPES.has(row.touchpoint_type)
    );
}

const secondsBetween = (a: string, b: string) =>
    Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));

function openEpisode(
    seq: number,
    holder: TrackingPerson,
    from_at: string,
    hop: HopInput | null,
    approximate: boolean,
): OwnershipEpisode {
    return {
        seq,
        holder,
        from_at,
        to_at: null,
        duration_sec: 0,
        handed_by: hop ? hop.actor : null,
        handoff_type: hop ? hop.touchpoint_type : null,
        handoff_label: hop ? hop.label : null,
        handoff_reason: hop ? hop.remarks : null,
        status_at_start: null,
        status_at_end: null,
        actions_count: 0,
        approximate,
    };
}

export function deriveEpisodes(
    lead: EpisodeLeadInput,
    hops: HopInput[],
    resolve: ResolvePerson,
    now: string,
): OwnershipEpisode[] {
    const episodes: OwnershipEpisode[] = [];

    // Rule 1 — episode 0.
    const first = hops[0];
    const firstHolder: TrackingPerson =
        first && first.recorded && first.from_owner_id
            ? resolve(first.from_owner_id)
            : UNASSIGNED_PERSON;
    episodes.push(
        openEpisode(0, firstHolder, lead.created_at, null, firstHolder.id != null),
    );

    const close = (at: string) => {
        const open = episodes[episodes.length - 1]!;
        // A hop can never predate the episode it closes; clamp so a clock skew
        // between created_at and the first touchpoint cannot go negative.
        open.to_at = Date.parse(at) < Date.parse(open.from_at) ? open.from_at : at;
    };

    // Rule 2 — one episode per hop.
    for (const hop of hops) {
        let holder: TrackingPerson;
        if (hop.recorded) {
            holder = hop.to_owner_id ? resolve(hop.to_owner_id) : UNASSIGNED_PERSON;
        } else if (hop.touchpoint_type === "lead_claimed" && hop.actor.id) {
            // A claim is a self-assignment even when the columns are missing.
            holder = hop.actor;
        } else {
            holder = NOT_RECORDED_PERSON;
        }
        // A hop to the person already holding the lead (e.g. NeoDove re-push,
        // or the same ASM again) is noise, not a new episode.
        const open = episodes[episodes.length - 1]!;
        if (holder.id != null && holder.id === open.holder.id) continue;

        close(hop.at);
        const from_at = episodes[episodes.length - 1]!.to_at!;
        episodes.push(openEpisode(episodes.length, holder, from_at, hop, !hop.recorded));
    }

    // Rule 3 — reconcile with the current owner.
    const open = episodes[episodes.length - 1]!;
    const currentId = lead.current_owner_id;
    const holderMatches =
        open.holder.id === currentId ||
        // Unassigned pool vs NULL owner is the same fact.
        (open.holder.id == null && currentId == null && open.holder !== NOT_RECORDED_PERSON);
    if (!holderMatches) {
        const holder = currentId ? resolve(currentId) : UNASSIGNED_PERSON;
        const candidate = currentId
            ? (lead.assigned_at ?? lead.updated_at ?? lead.created_at)
            : (lead.updated_at ?? now);
        // Must lie inside the open episode: never before it began, never after now.
        const lo = Date.parse(open.from_at);
        const hi = Date.parse(now);
        const t = Math.min(hi, Math.max(lo, Date.parse(candidate)));
        // Keep the source text when unclamped so timestamps stay in the one
        // shape the database emitted (no ".000" drift between rows).
        const at =
            t === Date.parse(candidate) ? candidate : new Date(t).toISOString();
        // If the open episode is the unrecorded kind and would become empty,
        // replace it rather than leave a zero-length "Not recorded" hold.
        if (open.holder === NOT_RECORDED_PERSON && t === lo) {
            open.holder = holder;
            open.approximate = true;
        } else {
            close(at);
            episodes.push(openEpisode(episodes.length, holder, at, null, true));
        }
    }

    // Rule 4 — durations.
    for (const e of episodes) {
        e.duration_sec = secondsBetween(e.from_at, e.to_at ?? now);
    }
    return episodes;
}

/**
 * Stamp every event with the episode active at its timestamp, count actions
 * per episode, and carry the running status across the boundaries.
 *
 * `events` must be sorted ascending by `at`; `episodes` as returned above.
 * Mutates both (episode counters / statuses, event episode_seq) and returns
 * the events for chaining.
 */
export function attachEvents(
    episodes: OwnershipEpisode[],
    events: TrackingEvent[],
    initialStatus: string | null,
): TrackingEvent[] {
    let status: string | null = initialStatus;
    let ei = 0;
    if (episodes[0]) episodes[0].status_at_start = status;

    for (const ev of events) {
        const t = Date.parse(ev.at);
        // Advance to the episode that contains `t`. A boundary belongs to the
        // NEW episode: the hop itself is the first thing that happened there.
        while (
            ei < episodes.length - 1 &&
            episodes[ei]!.to_at != null &&
            t >= Date.parse(episodes[ei]!.to_at!)
        ) {
            episodes[ei]!.status_at_end = status;
            ei++;
            episodes[ei]!.status_at_start = status;
        }
        ev.episode_seq = episodes[ei]!.seq;
        episodes[ei]!.actions_count++;
        if (ev.kind === "status_change" && ev.status_to) status = ev.status_to;
    }
    // Close out the remaining boundaries with whatever status stood at the end.
    for (; ei < episodes.length - 1; ei++) {
        episodes[ei]!.status_at_end = status;
        episodes[ei + 1]!.status_at_start = status;
    }
    episodes[episodes.length - 1]!.status_at_end = status;
    return events;
}
