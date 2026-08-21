/**
 * Where the duration histogram's bucket boundaries come from.
 *
 * RESOLUTION ORDER — app_settings row > built-in default.
 *   Same shape as src/lib/leads/quote-pdf/config.ts and
 *   src/lib/telemetry/thresholds.ts. An unconfigured database renders the six
 *   buckets the team asked for; a row in app_settings retunes them without a
 *   deploy. There is no admin UI by decision — see ./config-store for the
 *   setter an operator would call.
 *
 * EDGES, NOT BUCKETS. The stored value is a list of interior boundaries, and
 * the buckets are derived from it. That is the load-bearing choice in this
 * file: it makes an overlapping or gapped bucket set INEXPRESSIBLE. The SQL
 * bins rows by joining against the bucket list, so two overlapping buckets
 * would double-count a call and quietly inflate the very number this feature
 * exists to report. You cannot write that bug through this interface.
 *
 * ── THE BOUNDARY RULE ──────────────────────────────────────────────────────
 * Buckets are HALF-OPEN, [lo, hi): a call of exactly 20 seconds belongs to
 * "20-40s", NOT to "<20s".
 *
 * This is worth being loud about because the whole feature turns on the 20
 * second line, so an off-by-one here is a reporting error, not a rounding
 * detail. The rule follows the label: "<20s" has to mean strictly under 20 or
 * the label is a lie. Note this differs from scripts/ai-call-analysis-report.ts,
 * which bucketed inclusive-upper (lo:1, hi:20) — historical figures from that
 * script will differ by however many calls landed exactly on a boundary.
 *
 * The top bucket is the one asymmetry: [300, inf) is displayed as ">5m" because
 * that is the vocabulary the team asked for, even though a call of exactly
 * 300 seconds falls inside it. The precise bounds are on the bucket object and
 * in the screen-reader text; the short label stays human. Do not "fix" the
 * label to ">=5m" — it was chosen.
 *
 * PURE — no database import, deliberately. The app_settings read lives in
 * ./config-store, so these defaults and this merge can be unit-tested without a
 * DATABASE_URL.
 */
import { DURATION_MAX_SECONDS } from "./derive";

export const DURATION_BUCKETS_SETTINGS_KEY = "ai_dialer_duration_buckets";

/**
 * Interior boundaries in seconds, ascending. N edges produce N+1 buckets.
 *
 * [20, 40, 60, 120, 300] gives: <20s | 20-40s | 40-60s | 1-2m | 2-5m | >5m
 *
 * The low end is deliberately fine-grained: production data puts roughly seven
 * in ten connected calls inside the first bucket, so the resolution is spent
 * where the calls actually are. The top two buckets are expected to read zero
 * on current call quality — that is honest headroom, not a bug, and they still
 * render.
 */
export const DEFAULT_DURATION_EDGES_SECONDS: readonly number[] = [20, 40, 60, 120, 300];

/** Most edges a configuration may ask for. Beyond this the chart is unreadable. */
export const MAX_DURATION_EDGES = 12;

export interface DurationBucketConfig {
    /** Strictly ascending, positive, whole seconds, all below DURATION_MAX_SECONDS. */
    edgesSeconds: number[];
    /**
     * Full label override. Must be exactly edgesSeconds.length + 1 long or it is
     * ignored in favour of derived labels — a partial list would silently
     * mislabel the buckets it did not cover.
     */
    labels: string[] | null;
}

export const DEFAULT_DURATION_BUCKET_CONFIG: DurationBucketConfig = {
    edgesSeconds: [...DEFAULT_DURATION_EDGES_SECONDS],
    labels: null,
};

export interface DurationBucket {
    /** 1-based, ascending. The SQL joins on this. */
    ord: number;
    /** Stable across config edits because it is derived from the bounds. */
    key: string;
    /** Short human label, e.g. "<20s". */
    label: string;
    /** Full sentence for screen readers, e.g. "Under 20 seconds". */
    aria: string;
    /** INCLUSIVE lower bound. 0 for the first bucket. */
    loSeconds: number;
    /** EXCLUSIVE upper bound. null means open-ended. */
    hiSeconds: number | null;
}

type BoundUnit = "s" | "m";

/** Seconds up to a minute, minutes past it. */
function unitFor(seconds: number): BoundUnit {
    return seconds < 60 ? "s" : "m";
}

/** The bare number a bound reads as in the given unit. "40" | "1" | "1.5" */
function boundValue(seconds: number, unit: BoundUnit): string {
    if (unit === "s") return String(seconds);
    const rounded = Math.round((seconds / 60) * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function fmtBoundAria(seconds: number): string {
    if (seconds < 60) return `${seconds} seconds`;
    const minutes = Math.round((seconds / 60) * 10) / 10;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * "<20s" | "20–40s" | "40–60s" | "1–2m" | ">5m" — the exact default vocabulary.
 *
 * A RANGE TAKES THE UNIT OF ITS LOWER BOUND, suffixed once at the end. That is
 * why 60 seconds reads as "40–60s" when it closes a range and as "1–2m" when it
 * opens one: the unit is a property of the range, not of the number. Rendering
 * each bound independently gives "40s–1m" and "1m–2m", which is how humans do
 * not write it. The first bucket has no lower bound to take a unit from, so it
 * borrows its upper bound's. En-dash throughout.
 */
export function formatBucketLabel(lo: number, hi: number | null): string {
    if (hi === null) {
        const unit = unitFor(lo);
        return `>${boundValue(lo, unit)}${unit}`;
    }
    if (lo === 0) {
        const unit = unitFor(hi);
        return `<${boundValue(hi, unit)}${unit}`;
    }
    const unit = unitFor(lo);
    return `${boundValue(lo, unit)}–${boundValue(hi, unit)}${unit}`;
}

function formatBucketAria(lo: number, hi: number | null): string {
    if (hi === null) return `${fmtBoundAria(lo)} and over`;
    if (lo === 0) return `Under ${fmtBoundAria(hi)}`;
    return `${fmtBoundAria(lo)} to ${fmtBoundAria(hi)}`;
}

function bucketKey(lo: number, hi: number | null): string {
    if (hi === null) return `gte${lo}`;
    if (lo === 0) return `lt${hi}`;
    return `s${lo}_${hi}`;
}

/**
 * Edges to contiguous, non-overlapping, half-open buckets.
 *
 * Every bucket's loSeconds equals the previous bucket's hiSeconds, so the set
 * tiles [0, inf) exactly once. That property is asserted in the unit tests and
 * relied on by the SQL.
 */
export function deriveBuckets(cfg: DurationBucketConfig): DurationBucket[] {
    const bounds: Array<[number, number | null]> = [];

    let lo = 0;
    for (const edge of cfg.edgesSeconds) {
        bounds.push([lo, edge]);
        lo = edge;
    }
    bounds.push([lo, null]);

    const labels = cfg.labels;
    const useLabels = labels != null && labels.length === bounds.length;

    return bounds.map(([bLo, bHi], i) => ({
        ord: i + 1,
        key: bucketKey(bLo, bHi),
        label: useLabels ? labels[i] : formatBucketLabel(bLo, bHi),
        aria: formatBucketAria(bLo, bHi),
        loSeconds: bLo,
        hiSeconds: bHi,
    }));
}

/**
 * Is this a usable edge list? Returns null when valid, else the reason.
 *
 * Strictly ascending catches duplicates and descending order in one test. The
 * upper bound check matters more than it looks: an edge at or beyond the
 * DURATION_MAX_SECONDS clamp creates a bucket that no call can ever enter,
 * because ./derive throws those durations away before they reach the histogram.
 */
export function validateEdges(edges: unknown): string | null {
    if (!Array.isArray(edges)) return "edgesSeconds must be an array";
    if (edges.length === 0) return "edgesSeconds must not be empty";
    if (edges.length > MAX_DURATION_EDGES) {
        return `edgesSeconds must have at most ${MAX_DURATION_EDGES} entries`;
    }

    let previous = 0;
    for (const edge of edges) {
        if (typeof edge !== "number" || !Number.isFinite(edge)) {
            return `edgesSeconds must contain only finite numbers, got ${JSON.stringify(edge)}`;
        }
        if (!Number.isInteger(edge)) return `edgesSeconds must be whole seconds, got ${edge}`;
        if (edge <= 0) return `edgesSeconds must be positive, got ${edge}`;
        if (edge <= previous) {
            return `edgesSeconds must be strictly ascending, got ${edge} after ${previous}`;
        }
        if (edge >= DURATION_MAX_SECONDS) {
            return `edgesSeconds must be below ${DURATION_MAX_SECONDS}, got ${edge}`;
        }
        previous = edge;
    }

    return null;
}

/**
 * Merge an app_settings jsonb value over the defaults. Never throws.
 *
 * Deliberately tolerant, matching mergeQuotationConfig: a malformed or partial
 * value degrades to the default for that field rather than throwing. A
 * fat-fingered settings row must never 500 the campaign detail page — the worst
 * it can do is show the documented default histogram.
 */
export function mergeDurationBucketConfig(
    patch: unknown,
    base: DurationBucketConfig = DEFAULT_DURATION_BUCKET_CONFIG,
): DurationBucketConfig {
    if (patch == null || typeof patch !== "object" || Array.isArray(patch)) {
        return { edgesSeconds: [...base.edgesSeconds], labels: base.labels };
    }

    const raw = patch as Record<string, unknown>;
    let edgesSeconds = [...base.edgesSeconds];

    if (raw.edgesSeconds !== undefined) {
        const reason = validateEdges(raw.edgesSeconds);
        if (reason) {
            console.warn(`[call-duration/config] ignoring app_settings edgesSeconds: ${reason}`);
        } else {
            edgesSeconds = [...(raw.edgesSeconds as number[])];
        }
    }

    let labels: string[] | null = base.labels;
    if (raw.labels !== undefined) {
        const candidate = raw.labels;
        const wanted = edgesSeconds.length + 1;
        if (
            Array.isArray(candidate) &&
            candidate.length === wanted &&
            candidate.every((l) => typeof l === "string" && l.trim() !== "")
        ) {
            labels = candidate as string[];
        } else {
            if (candidate !== null) {
                console.warn(
                    `[call-duration/config] ignoring app_settings labels: expected ${wanted} non-empty strings`,
                );
            }
            labels = null;
        }
    }

    return { edgesSeconds, labels };
}

/**
 * Which bucket does this duration fall in? null when there is no duration.
 *
 * Half-open, so the comparison is `>= lo` and `< hi`. Used by the Excel export,
 * which labels one row at a time rather than aggregating.
 */
export function bucketFor(
    seconds: number | null | undefined,
    buckets: DurationBucket[],
): DurationBucket | null {
    if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
    for (const b of buckets) {
        if (seconds >= b.loSeconds && (b.hiSeconds === null || seconds < b.hiSeconds)) {
            return b;
        }
    }
    return null;
}
