/**
 * Lead Tracking — the shapes the panel, the CSV and the API share (E-295).
 *
 * CLIENT-SAFE: no db import, so the drawer and the inside-sales tab can import
 * these without dragging postgres into the bundle. The builder that fills them
 * lives in src/lib/leads/tracking.ts; the pure derivation in
 * src/lib/leads/trackingEpisodes.ts.
 *
 * Vocabulary:
 *   episode  — one uninterrupted hold of the lead by one person (or by nobody:
 *              the "Unassigned" pool). Episodes tile the lead's life from
 *              created_at to now with no gaps and no overlap.
 *   hop      — the touchpoint that closed one episode and opened the next.
 *   event    — anything anyone did on the lead: a touchpoint or a status change.
 *              Every event belongs to exactly one episode (the one active when
 *              it happened), which is how "what did X do while holding it" is
 *              answered.
 */

export type TrackingPerson = {
    /** users.id as text; null for the pool / system / an unrecorded recipient. */
    id: string | null;
    name: string;
    /** users.role; null when unknown or not a person. */
    role: string | null;
};

export const UNASSIGNED_PERSON: TrackingPerson = {
    id: null,
    name: "Unassigned",
    role: null,
};
export const SYSTEM_PERSON: TrackingPerson = { id: null, name: "System", role: null };
/** A pre-E-295 hop whose recipient was never written down. Never guessed. */
export const NOT_RECORDED_PERSON: TrackingPerson = {
    id: null,
    name: "Not recorded",
    role: null,
};

export type OwnershipEpisode = {
    /** 0-based, chronological. */
    seq: number;
    holder: TrackingPerson;
    /** ISO-8601 UTC. */
    from_at: string;
    /** ISO-8601 UTC; null while this is the live episode. */
    to_at: string | null;
    /** Seconds held; the live episode counts up to `now`. */
    duration_sec: number;
    /** Who performed the hop that opened this episode; null for episode 0. */
    handed_by: TrackingPerson | null;
    /** touchpoint_type of the opening hop (lead_claimed, asm_transfer, …). */
    handoff_type: string | null;
    /** Human label for handoff_type. */
    handoff_label: string | null;
    /** remarks on the opening hop — the reassign reason, the hand-off notes. */
    handoff_reason: string | null;
    status_at_start: string | null;
    status_at_end: string | null;
    /** Events attributed to this episode. */
    actions_count: number;
    /**
     * True when this episode was RECONSTRUCTED (from assigned_at, or from a
     * hop's from_owner_id) rather than opened by a recorded hop — pre-E-295
     * history. Its boundaries are best-effort.
     */
    approximate: boolean;
};

export type TrackingEventKind = "touchpoint" | "status_change";

export type TrackingEvent = {
    /** ISO-8601 UTC. */
    at: string;
    actor: TrackingPerson;
    kind: TrackingEventKind;
    /** Human label: "Reassigned", "Call", "Status change". */
    action: string;
    /** Raw machine value: touchpoint_type, or `status:<to_status>`. */
    type_code: string;
    details: string | null;
    status_from: string | null;
    status_to: string | null;
    call_status: string | null;
    duration_sec: number | null;
    next_action: string | null;
    /** For hops: where the lead went. Null on ordinary events. */
    to_person: TrackingPerson | null;
    /** The episode this event happened in. */
    episode_seq: number;
};

export type LeadTrackingLead = {
    id: string;
    dealer_name: string | null;
    shop_name: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    source: string | null;
    /** ISO-8601 UTC. */
    created_at: string;
    closed_at: string | null;
    lead_status: string | null;
    current_owner: TrackingPerson;
    asm: TrackingPerson | null;
    age_sec: number;
    time_in_status_sec: number;
    time_with_owner_sec: number;
    /** Number of recorded hand-offs (episodes − 1). */
    handoffs: number;
};

export type LeadTracking = {
    lead: LeadTrackingLead;
    episodes: OwnershipEpisode[];
    /** Oldest first. */
    events: TrackingEvent[];
    /** True when the event query hit its cap and the tail was dropped. */
    truncated: boolean;
    /** The server clock the durations were measured against. */
    as_of: string;
};

/** `3d 4h 12m` / `4h 12m` / `12m` / `<1m`. */
export function fmtDuration(sec: number | null | undefined): string {
    if (sec == null || !Number.isFinite(sec)) return "—";
    const s = Math.max(0, Math.floor(sec));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return "<1m";
}

/** `inside_sales_rep` → `Inside Sales Rep`; null → "". */
export function prettyRole(role: string | null | undefined): string {
    if (!role) return "";
    return role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
