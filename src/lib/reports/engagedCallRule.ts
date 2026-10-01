// The engaged-call rule as a SETTING (tracker ID 59; reporting spec M06
// "threshold in config, editable by the Sales Head").
//
// One jsonb blob under `engaged_call_rule` in app_settings — no table of its
// own, so no migration:
//   { min_seconds: 30, duration_source: "neodove" | "reported", updated_by }
//
//   min_seconds       a connected call of at least this many MEASURED seconds
//                     is engaged.
//   duration_source   whose duration is a measurement. "neodove" (default):
//                     only NeoDove's recorded duration. "reported": a duration
//                     a rep typed counts too — tracker question 6, a business
//                     decision that is now a setting rather than a deploy.
//
// READERS do not come through here: the SQL fragments in metricDefinitions.ts
// look the same row up inline, so a saved change reaches every report on the
// next query. This module serves the WRITERS (what is stored in is_engaged)
// and the settings screen. The pure rule is in lifecycle/touchpointTypes.ts.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
    DEFAULT_ENGAGED_CALL_RULE,
    ENGAGED_CALL_RULE_KEY,
    normalizeEngagedCallRule,
    type EngagedCallRule,
} from "@/lib/lifecycle/touchpointTypes";

export type EngagedCallRuleSettings = EngagedCallRule & {
    updated_by_name: string | null;
    updated_at: string | null;
};

const CACHE_MS = 60_000;
let cached: { rule: EngagedCallRule; at: number } | null = null;

/** The saved rule plus who last changed it — for the settings screen. Never throws. */
export async function getEngagedCallRuleSettings(): Promise<EngagedCallRuleSettings> {
    try {
        const rows = (await db.execute(sql`
            SELECT s.value, s.updated_at, u.name AS updated_by_name
              FROM app_settings s
              LEFT JOIN users u ON u.id::text = s.value ->> 'updated_by'
             WHERE s.key = ${ENGAGED_CALL_RULE_KEY}
             LIMIT 1
        `)) as unknown as Array<{ value: unknown; updated_at: string | null; updated_by_name: string | null }>;
        const row = rows[0];
        return {
            ...normalizeEngagedCallRule(row?.value),
            updated_by_name: row?.updated_by_name ?? null,
            updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
        };
    } catch (e) {
        console.warn("[engagedCallRule] could not read the setting — using the default", {
            error: e instanceof Error ? e.message : String(e),
        });
        return { ...DEFAULT_ENGAGED_CALL_RULE, updated_by_name: null, updated_at: null };
    }
}

/**
 * The rule the writers apply. Cached for a minute per process: it decides only
 * what is STORED on a new call row, and reports never read that flag for a
 * call, so a writer a minute behind a settings change is harmless.
 */
export async function getEngagedCallRule(): Promise<EngagedCallRule> {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.rule;
    const { minSeconds, durationSource } = await getEngagedCallRuleSettings();
    cached = { rule: { minSeconds, durationSource }, at: Date.now() };
    return cached.rule;
}

/** Save the rule. Throws on a DB failure — the person changing a metric must know. */
export async function setEngagedCallRule(input: unknown, updatedBy: string): Promise<EngagedCallRuleSettings> {
    const rule = normalizeEngagedCallRule(input);
    const value = JSON.stringify({
        min_seconds: rule.minSeconds,
        duration_source: rule.durationSource,
        updated_by: updatedBy,
    });
    await db.execute(sql`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (${ENGAGED_CALL_RULE_KEY}, ${value}::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `);
    cached = null;
    return getEngagedCallRuleSettings();
}
