// Reports › Data downloads — "Save as my column set" (tracker ID 13): the
// columns a person keeps ticked on a dataset, remembered per person in
// user_preferences (E-124) under `data_download_columns:<dataset id>`.
// SERVER ONLY.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

const PREFIX = "data_download_columns:";

/** Every saved column set of this person, by dataset id. Never throws. */
export async function savedColumnSets(userId: string): Promise<Record<string, string[]>> {
    try {
        const rows = (await db.execute(sql`
            SELECT pref_key, pref_value FROM user_preferences
             WHERE user_id = ${userId} AND pref_key LIKE ${`${PREFIX}%`}
        `)) as unknown as Array<{ pref_key: string; pref_value: unknown }>;
        const out: Record<string, string[]> = {};
        for (const r of rows) {
            if (Array.isArray(r.pref_value)) out[r.pref_key.slice(PREFIX.length)] = r.pref_value.map(String);
        }
        return out;
    } catch {
        return {};
    }
}

/** Save the set; an empty list forgets it (every column again). */
export async function saveColumnSet(userId: string, datasetId: string, columns: string[]): Promise<void> {
    const key = `${PREFIX}${datasetId}`;
    if (columns.length === 0) {
        await db.execute(sql`DELETE FROM user_preferences WHERE user_id = ${userId} AND pref_key = ${key}`);
        return;
    }
    await db.execute(sql`
        INSERT INTO user_preferences (user_id, pref_key, pref_value)
        VALUES (${userId}, ${key}, ${JSON.stringify(columns)}::jsonb)
        ON CONFLICT (user_id, pref_key) DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = now()
    `);
}
