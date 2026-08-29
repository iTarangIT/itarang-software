/**
 * The app_settings half of the duration bucket config.
 *
 * Split from ./config so the defaults, the validation and the merge stay
 * importable without a DATABASE_URL — the same reason
 * src/lib/telemetry/thresholds-math.ts is split from thresholds.ts, and the
 * same split src/lib/leads/quote-pdf uses. Everything pure is re-exported here,
 * so a caller that wants both needs only this module.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import {
    DEFAULT_DURATION_BUCKET_CONFIG,
    DURATION_BUCKETS_SETTINGS_KEY,
    deriveBuckets,
    mergeDurationBucketConfig,
    validateEdges,
    type DurationBucket,
    type DurationBucketConfig,
} from "./config";

export * from "./config";

export interface ResolvedDurationBuckets {
    config: DurationBucketConfig;
    buckets: DurationBucket[];
    /** Which side of the resolution order won. Surfaced so the UI can say so. */
    source: "default" | "app_settings";
}

/**
 * The bucket configuration in force, from app_settings if a row exists.
 *
 * Never throws. A failed read, a missing row or a malformed value all yield the
 * documented defaults, because the alternative is a settings typo taking down
 * the campaign detail page — and this panel is diagnostic, not transactional.
 * Nothing downstream of it is worth a 500.
 */
export async function resolveDurationBucketConfig(): Promise<ResolvedDurationBuckets> {
    try {
        const [row] = await db
            .select({ value: appSettings.value })
            .from(appSettings)
            .where(eq(appSettings.key, DURATION_BUCKETS_SETTINGS_KEY))
            .limit(1);

        const config = mergeDurationBucketConfig(row?.value);
        return {
            config,
            buckets: deriveBuckets(config),
            source: row ? "app_settings" : "default",
        };
    } catch (e) {
        console.error("[call-duration/config-store] falling back to defaults", e);
        return {
            config: DEFAULT_DURATION_BUCKET_CONFIG,
            buckets: deriveBuckets(DEFAULT_DURATION_BUCKET_CONFIG),
            source: "default",
        };
    }
}

/**
 * Retune the buckets without a deploy.
 *
 * There is no admin UI by decision, so this exists to make an ops change one
 * `tsx -e` away rather than hand-written SQL against a jsonb column. Unlike the
 * resolver it DOES throw on a bad edge list: a setter that silently wrote
 * garbage and reported success would be worse than useless.
 */
export async function setDurationBucketConfig(
    next: Partial<DurationBucketConfig>,
): Promise<DurationBucketConfig> {
    if (next.edgesSeconds !== undefined) {
        const reason = validateEdges(next.edgesSeconds);
        if (reason) throw new Error(`Refusing to store duration buckets: ${reason}`);
    }

    const merged = mergeDurationBucketConfig(next);

    await db
        .insert(appSettings)
        .values({
            key: DURATION_BUCKETS_SETTINGS_KEY,
            value: merged,
            updated_at: new Date(),
        })
        .onConflictDoUpdate({
            target: appSettings.key,
            set: { value: merged, updated_at: new Date() },
        });

    return merged;
}
