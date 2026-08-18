// The call-centre disposition vocabulary, from "CC Team Lead Dispositions".
//
// This is the list `docs/neodove-contract.md` §4 left blank. Until it existed,
// `DISPOSITION_TO_CALL_STATUS` in src/lib/neodove/mapper.ts was an explicit
// guess over NeoDove's factory defaults, and the account's real dispositions —
// "Bad Experience with Trontek", "REJECTED BY US", "Short Hang up" — matched
// none of them. Every such call fell through to the `callConnected` boolean.
//
// WHY A MODULE AND NOT A TABLE. The vocabulary is owned by the CC team and
// changes at the pace of a spreadsheet, not of a user. A table would need an
// admin CRUD screen nobody asked for, plus a seed that drifts per environment —
// and the three places that need this list (the filter UI, the query validator,
// the inbound classifier) would each have to tolerate it being empty. Same
// treatment as LEAD_STATUS / LOST_REASON in src/lib/lifecycle/transitions.ts.
//
// WHY IT IS NOT NEODOVE-SPECIFIC. It lives under leads/, not neodove/, because
// the dispositions describe what happened on a call, not who dialled it. An
// inside-sales rep logging a call by hand should eventually pick from this same
// list; nothing here imports NeoDove.
//
// ── THE SHAPE ──────────────────────────────────────────────────────────────
// Three levels, exactly as the sheet has them:
//
//   L1  Connected                     |  Not Connected
//   L2  Cold Warm Hot Converted Lost  |  (none)
//   L3  the disposition the agent taps
//
// Under "Not Connected" the sheet puts its ten reasons in the L2 column with no
// L3. They are modelled here at L3 with `bucket: null`, because they ARE what
// the agent taps — the same slot "Price High" occupies. That is why the filter
// UI hides the bucket select once Not Connected is chosen: there is nothing to
// choose.

// Type-only: touchpointTypes.ts imports nothing, so this cannot cycle and stays
// safe in a client bundle.
import type { CallStatus as TouchpointCallStatus } from "@/lib/lifecycle/touchpointTypes";

export const CONNECT_STATUS = ["connected", "not_connected"] as const;
export type ConnectStatus = (typeof CONNECT_STATUS)[number];

export const DISPOSITION_BUCKETS = [
    "Cold",
    "Warm",
    "Hot",
    "Converted",
    "Lost",
] as const;
export type DispositionBucket = (typeof DISPOSITION_BUCKETS)[number];

/**
 * L2 → L3, for calls that connected.
 *
 * ⚠ "Commercials Explained" appears under BOTH Warm and Hot in the sheet. That
 * is the source data, not a transcription slip, and it is the one place this
 * taxonomy cannot be a pure tree. See resolveBucket() for how it is settled.
 */
export const CONNECTED_DISPOSITIONS: Record<DispositionBucket, readonly string[]> = {
    Cold: [
        "Loan Procedure Issue",
        "Service Issue",
        "As to Call Back",
        "Need Some Time",
        "No requirement in current",
        "Bad Experience with Trontek",
        "Short Hang up",
    ],
    Warm: [
        "Details Shared",
        "Information Collected",
        "Meeting Scheduled",
        "Commercials Explained",
        "Price High",
    ],
    Hot: [
        "Quotation Sent",
        "Commercials Explained",
        "Under Negotiation",
        "Documents Recieved",
        "Commercials Finalised",
    ],
    Converted: [
        "Deal Closed",
        "Order Received",
        "Full Payment Received",
        "Onboarding Done",
    ],
    Lost: [
        "Not Interested",
        "Lost to Competition",
        "Some other Business",
        "Business Closed",
        "REJECTED BY US",
    ],
} as const;

/** L1 = Not Connected. Ten reasons, no bucket. */
export const NOT_CONNECTED_REASONS = [
    "Did not pick",
    "Busy in another call",
    "User disconnected the call",
    "Switch off",
    "Out of Coverage area / Network issue",
    "Call not connected / can not be completed",
    "Other reason",
    "Incorrect / Invalid number",
    "Incoming calls not available",
    "Number not in use / does not exist / out of service",
] as const;

/** Every connected L3, de-duplicated, in sheet order. */
export const ALL_CONNECTED_DISPOSITIONS: readonly string[] = (() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const bucket of DISPOSITION_BUCKETS) {
        for (const label of CONNECTED_DISPOSITIONS[bucket]) {
            if (!seen.has(label)) {
                seen.add(label);
                out.push(label);
            }
        }
    }
    return out;
})();

// ── Normalisation ─────────────────────────────────────────────────────────

// Spelling variants that must resolve to the same disposition. The sheet's own
// "Documents Recieved" is a typo; the day someone fixes it in NeoDove's settings
// every historical row must not silently become unmapped, and vice versa. Keys
// and values are both run through normalizeDispositionKey().
const ALIASES: Record<string, string> = {
    "documents received": "Documents Recieved",
    "commercials finalized": "Commercials Finalised",
    "ask to call back": "As to Call Back",
    "asked to call back": "As to Call Back",
    "switched off": "Switch off",
    "wrong number": "Incorrect / Invalid number",
    "invalid number": "Incorrect / Invalid number",
    "incorrect number": "Incorrect / Invalid number",
    "did not pickup": "Did not pick",
    "didn't pick": "Did not pick",
    "no answer": "Did not pick",
    "not answered": "Did not pick",
    "rejected by us": "REJECTED BY US",
};

/**
 * Lookup key for a raw disposition string.
 *
 * Case, surrounding whitespace, doubled spaces and the spacing around a slash
 * all vary between NeoDove's UI, their CSV export and whatever a telecaller
 * typed. None of them change which disposition it is.
 */
export function normalizeDispositionKey(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/\s*\/\s*/g, " / ")
        .replace(/\s+/g, " ");
}

// key → { label, bucket, connectStatus }, built once from the tables above.
type Entry = {
    label: string;
    bucket: DispositionBucket | null;
    connectStatus: ConnectStatus;
};

const INDEX: Map<string, Entry> = (() => {
    const map = new Map<string, Entry>();
    // Buckets in sheet order, and only the FIRST occurrence of a label wins —
    // this is what makes "Commercials Explained" default to Warm.
    for (const bucket of DISPOSITION_BUCKETS) {
        for (const label of CONNECTED_DISPOSITIONS[bucket]) {
            const key = normalizeDispositionKey(label);
            if (!map.has(key)) {
                map.set(key, { label, bucket, connectStatus: "connected" });
            }
        }
    }
    for (const label of NOT_CONNECTED_REASONS) {
        map.set(normalizeDispositionKey(label), {
            label,
            bucket: null,
            connectStatus: "not_connected",
        });
    }
    for (const [alias, target] of Object.entries(ALIASES)) {
        const hit = map.get(normalizeDispositionKey(target));
        if (hit) map.set(normalizeDispositionKey(alias), hit);
    }
    return map;
})();

/** Which buckets list this exact label. Length > 1 only for the Warm/Hot clash. */
function bucketsFor(label: string): DispositionBucket[] {
    const key = normalizeDispositionKey(label);
    return DISPOSITION_BUCKETS.filter((b) =>
        CONNECTED_DISPOSITIONS[b].some((l) => normalizeDispositionKey(l) === key),
    );
}

// NeoDove's own `lead_stage_name`, lowercased, → the bucket it implies. Used
// ONLY to break the Warm/Hot tie; it is never trusted to assign a bucket on its
// own, because the account's stage list ("Cold", "IN-PROGRESS", "Lost",
// "Converted") is coarser than the sheet's and collapses Warm and Hot into one.
const STAGE_HINT_TO_BUCKET: Record<string, DispositionBucket> = {
    cold: "Cold",
    warm: "Warm",
    hot: "Hot",
    negotiation: "Hot",
    "under negotiation": "Hot",
    converted: "Converted",
    won: "Converted",
    lost: "Lost",
};

export type DispositionHints = {
    /** NeoDove `lead_stage_name`, if the payload carried one. */
    stage?: string | null;
    /** NeoDove `call_connected`, if the payload carried one. */
    callConnected?: boolean | null;
};

export type ClassifiedDisposition = {
    /** Canonical casing when the value is in the sheet; the raw string when not. */
    label: string;
    /** null for a not-connected reason, and for anything outside the sheet. */
    bucket: DispositionBucket | null;
    /** null only when nothing in the payload said whether the call connected. */
    connectStatus: ConnectStatus | null;
    /** false when the value is not in the sheet — surfaced, never silently dropped. */
    isKnown: boolean;
};

/**
 * Classify a raw disposition string against the sheet.
 *
 * NEVER returns null for a non-empty input and never invents a bucket. An
 * unrecognised value comes back with `isKnown: false` and its raw text intact,
 * because a disposition the CRM cannot name is still evidence a human made the
 * call — and because silently dropping it is how a vocabulary change in
 * NeoDove's settings would go unnoticed for weeks. Same rule the inbound mapper
 * already follows (src/lib/neodove/mapper.ts:10-16).
 */
export function classifyDisposition(
    raw: string | null | undefined,
    hints: DispositionHints = {},
): ClassifiedDisposition | null {
    const text = (raw ?? "").trim();
    if (!text) return null;

    const hit = INDEX.get(normalizeDispositionKey(text));
    if (!hit) {
        return {
            label: text,
            bucket: null,
            connectStatus: connectStatusFromHints(hints),
            isKnown: false,
        };
    }

    return {
        label: hit.label,
        bucket:
            hit.connectStatus === "connected"
                ? resolveBucket(hit.label, hit.bucket, hints)
                : null,
        connectStatus: hit.connectStatus,
        isKnown: true,
    };
}

/**
 * Settle a label that sits in more than one bucket.
 *
 * Exported because a caller that KNOWS the bucket can settle it honestly. The
 * inbound webhook cannot — there is no user to ask, so it accepts the Warm
 * default described below. A rep picking "Commercials Explained" from a dropdown
 * under Hot has told us which one they mean, and storing Warm for them would
 * make the Hot filter under-count on purpose.
 *
 * Only "Commercials Explained" (Warm and Hot) reaches the ambiguous branch
 * today. NeoDove's stage decides when it disambiguates; otherwise the sheet's
 * first occurrence wins, which is Warm. The consequence, deliberately chosen
 * over the alternative: filtering by Hot UNDER-counts Commercials Explained
 * rather than the Warm and Hot filters both over-counting it and their totals
 * exceeding the row count.
 */
export function resolveBucket(
    label: string,
    fallback: DispositionBucket | null,
    hints: DispositionHints,
): DispositionBucket | null {
    const candidates = bucketsFor(label);
    if (candidates.length <= 1) return fallback;

    const hinted = hints.stage
        ? STAGE_HINT_TO_BUCKET[normalizeDispositionKey(hints.stage)]
        : undefined;
    return hinted && candidates.includes(hinted) ? hinted : fallback;
}

function connectStatusFromHints(hints: DispositionHints): ConnectStatus | null {
    if (hints.callConnected === true) return "connected";
    if (hints.callConnected === false) return "not_connected";
    return null;
}

// ── Type guards for untrusted query-string values ─────────────────────────

export function isConnectStatus(v: string | null | undefined): v is ConnectStatus {
    return v === "connected" || v === "not_connected";
}

export function isDispositionBucket(
    v: string | null | undefined,
): v is DispositionBucket {
    return (DISPOSITION_BUCKETS as readonly string[]).includes(v ?? "");
}

/**
 * Is this one of the sheet's dispositions?
 *
 * The filter route uses this to decide whether a `?disposition=` value is worth
 * querying for. It answers for the CANONICAL vocabulary only — a value that
 * arrived from NeoDove outside the sheet is legitimately filterable too, which
 * is why the route also accepts anything the facets query reports as present in
 * the data rather than rejecting on this alone.
 */
export function isKnownDisposition(v: string | null | undefined): boolean {
    if (!v) return false;
    return INDEX.has(normalizeDispositionKey(v));
}

/** Canonical casing for a known label; the input unchanged otherwise. */
export function canonicalDisposition(v: string): string {
    return INDEX.get(normalizeDispositionKey(v))?.label ?? v;
}

// ── The 5-value touchpoint vocabulary implied by a disposition ────────────
//
// lead_touchpoints.call_status has its own, older, five-value vocabulary
// (CALL_STATUS in src/lib/lifecycle/touchpointTypes.ts). Every writer of a
// touchpoint needs to derive one from the other, and there are three of them
// now — the NeoDove webhook, the AI dialer, and the rep's Log Touchpoint form.
// This table used to be private to src/lib/neodove/mapper.ts, which made it
// look NeoDove-specific. It is not: it is a property of the sheet.
//
// Typed over the NOT_CONNECTED_REASONS tuple, so adding a reason to the sheet
// without deciding its call status is a compile error rather than a silent
// `undefined` that falls through to "not_responding".
//
// The connected side needs no table: a disposition the sheet files under
// Connected means the call connected, by definition.
//
// Note "Short Hang up" is deliberately absent — the sheet files it under
// Connected › Cold, and rightly so. A hang-up after one second is still a
// connected call, and counting it as not_responding would understate the
// connect rate.

export const NOT_CONNECTED_TO_CALL_STATUS: Record<
    (typeof NOT_CONNECTED_REASONS)[number],
    TouchpointCallStatus
> = {
    "Did not pick": "not_responding",
    "Busy in another call": "not_responding",
    "User disconnected the call": "not_responding",
    "Call not connected / can not be completed": "not_responding",
    "Other reason": "not_responding",
    "Switch off": "not_reachable",
    "Out of Coverage area / Network issue": "not_reachable",
    "Number not in use / does not exist / out of service": "not_reachable",
    "Incorrect / Invalid number": "incorrect_number",
    "Incoming calls not available": "no_incoming",
};

/**
 * The touchpoint call_status implied by a classified disposition.
 *
 * Returns null when there is nothing to imply — no disposition, or one outside
 * the sheet whose connect status is unknown. Callers fall back to their own
 * evidence (NeoDove's stock-vocabulary map, or a rep's explicit choice).
 */
export function callStatusForDisposition(
    d: Pick<ClassifiedDisposition, "label" | "connectStatus"> | null | undefined,
): TouchpointCallStatus | null {
    if (!d) return null;
    if (d.connectStatus === "connected") return "connected";
    if (d.connectStatus === "not_connected") {
        return (
            NOT_CONNECTED_TO_CALL_STATUS[
                d.label as (typeof NOT_CONNECTED_REASONS)[number]
            ] ?? null
        );
    }
    return null;
}

// ── Display ───────────────────────────────────────────────────────────────

export const CONNECT_STATUS_LABEL: Record<ConnectStatus, string> = {
    connected: "Connected",
    not_connected: "Not Connected",
};

/** Chip tone per bucket. Same border/bg/text triple as INTENT_BUCKET_TONE, so a
 *  disposition chip and an intent chip on the same row read as one set. */
export const DISPOSITION_BUCKET_TONE: Record<DispositionBucket, string> = {
    Cold: "bg-sky-50 text-sky-700 border-sky-200",
    Warm: "bg-amber-50 text-amber-700 border-amber-200",
    Hot: "bg-rose-50 text-rose-700 border-rose-200",
    Converted: "bg-emerald-50 text-emerald-700 border-emerald-200",
    Lost: "bg-gray-100 text-gray-600 border-gray-300",
};

/** Tone for a row with no bucket: a not-connected reason, or an unmapped value. */
export const DISPOSITION_NEUTRAL_TONE =
    "bg-slate-50 text-slate-600 border-slate-200";
