/**
 * E-322 — the standard warranty / delivery terms printed on every quotation
 * (tracker ID 73). Stored in app_settings['quotation_standard_terms'];
 * edited by Admin / CEO in Admin → Settings → Quotation terms. Reps never
 * type them. Rules: ./quoteTermsRules.ts.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import {
    DEFAULT_STANDARD_TERMS,
    mergeStandardTerms,
    type StandardQuoteTerms,
} from "@/lib/leads/quoteTermsRules";

export * from "@/lib/leads/quoteTermsRules";

export const STANDARD_TERMS_KEY = "quotation_standard_terms";

export interface StandardTermsSettings extends StandardQuoteTerms {
    updated_by_name: string | null;
    updated_at: string | null;
}

type Runner = Pick<typeof db, "execute">;

/** Never throws: a failed read falls back to the defaults. */
export async function getStandardQuoteTerms(runner: Runner = db): Promise<StandardTermsSettings> {
    try {
        const rows = (await runner.execute(sql`
            SELECT s.value, s.updated_at, u.name AS updated_by_name
              FROM app_settings s
              LEFT JOIN users u ON u.id::text = s.value->>'updated_by'
             WHERE s.key = ${STANDARD_TERMS_KEY}
             LIMIT 1
        `)) as unknown as Array<{ value: unknown; updated_at: string | null; updated_by_name: string | null }>;
        const row = rows[0];
        return {
            ...mergeStandardTerms(row?.value),
            updated_by_name: row?.updated_by_name ?? null,
            updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
        };
    } catch (e) {
        console.warn("[quoteTerms] could not read standard terms — using defaults", {
            error: e instanceof Error ? e.message : String(e),
        });
        return { ...DEFAULT_STANDARD_TERMS, updated_by_name: null, updated_at: null };
    }
}

export async function setStandardQuoteTerms(
    terms: StandardQuoteTerms,
    updatedBy: string,
): Promise<StandardTermsSettings> {
    const value = { warranty: terms.warranty.trim(), delivery: terms.delivery.trim(), updated_by: updatedBy };
    const now = new Date();
    await db
        .insert(appSettings)
        .values({ key: STANDARD_TERMS_KEY, value, updated_at: now })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updated_at: now } });
    return getStandardQuoteTerms();
}
