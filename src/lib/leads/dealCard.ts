/**
 * Quote deal card store (tracker ID 172, E-336). Rules: ./dealCardRules.ts.
 *
 * The four columns are NOT in schema.ts (see the migration header): reads go
 * through to_jsonb(row), writes through raw SQL behind hasDealCardColumns(),
 * so a database without E-336 saves quotes as before and shows "—".
 */
import { sql, type SQL } from "drizzle-orm";
import type { db } from "@/lib/db";
import {
    dealCardLockedBy,
    normaliseDealCard,
    parseDealCard,
    type DealCard,
} from "@/lib/leads/dealCardRules";

type Exec = Pick<typeof db, "execute">;

/** jsonb with the four deal-card fields of commercials row `alias` (null fields on a DB without E-336). */
export function dealCardJson(alias: string): SQL {
    const row = sql.raw(`to_jsonb(${alias})`);
    return sql`jsonb_build_object(
        'onboarding_fee', ${row} -> 'onboarding_fee',
        'fee_waived_reason', ${row} -> 'fee_waived_reason',
        'expected_batteries_per_month', ${row} -> 'expected_batteries_per_month',
        'expected_finance_files_per_month', ${row} -> 'expected_finance_files_per_month')`;
}

export async function hasDealCardColumns(ex: Exec): Promise<boolean> {
    const rows = (await ex.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'dealer_lead_commercials'
           AND column_name IN ('onboarding_fee', 'fee_waived_reason',
                               'expected_batteries_per_month', 'expected_finance_files_per_month')
    `)) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0) === 4;
}

export type LockedDealCard = { card: DealCard; by: "ceo" | "dealer"; versionNo: number; commercialId: string };

/**
 * The lead's locked deal card: the latest quote (not withdrawn, not rejected)
 * that carries a card and that the CEO approved or the dealer said yes to.
 */
export async function readLockedDealCard(ex: Exec, leadId: string): Promise<LockedDealCard | null> {
    const rows = (await ex.execute<{
        commercial_id: string;
        version_no: number;
        approval_status: string | null;
        approved_by: string | null;
        dealer_decision: string | null;
        card: unknown;
    }>(sql`
        SELECT c.commercial_id::text AS commercial_id, c.version_no, c.approval_status,
               c.approved_by::text AS approved_by, c.dealer_decision,
               ${dealCardJson("c")} AS card
          FROM dealer_lead_commercials c
         WHERE c.dealer_lead_id = ${leadId}
           AND c.event_type IN ('quote_issue', 'quote_revision')
           AND c.withdrawn_at IS NULL
           AND c.approval_status IS DISTINCT FROM 'rejected'
           AND (c.dealer_decision = 'approved'
                OR (c.approval_status = 'approved' AND c.approved_by IS NOT NULL))
         ORDER BY c.version_no DESC
    `)) as unknown as Array<{
        commercial_id: string;
        version_no: number;
        approval_status: string | null;
        approved_by: string | null;
        dealer_decision: string | null;
        card: unknown;
    }>;
    for (const r of rows) {
        const card = parseDealCard(r.card);
        const by = dealCardLockedBy(r);
        if (card && by) return { card, by, versionNo: Number(r.version_no), commercialId: r.commercial_id };
    }
    return null;
}

/** The deal card of the lead's latest quote (any state but withdrawn / rejected), for terms events. */
export async function readLatestDealCard(ex: Exec, leadId: string): Promise<DealCard | null> {
    const rows = (await ex.execute<{ card: unknown }>(sql`
        SELECT ${dealCardJson("c")} AS card
          FROM dealer_lead_commercials c
         WHERE c.dealer_lead_id = ${leadId}
           AND c.event_type IN ('quote_issue', 'quote_revision')
           AND c.withdrawn_at IS NULL
           AND c.approval_status IS DISTINCT FROM 'rejected'
         ORDER BY c.version_no DESC
         LIMIT 1
    `)) as unknown as Array<{ card: unknown }>;
    return parseDealCard(rows[0]?.card);
}

/** Write the card onto one commercials row. Caller has checked hasDealCardColumns. */
export async function writeDealCard(ex: Exec, commercialId: string, card: DealCard): Promise<void> {
    const c = normaliseDealCard(card);
    await ex.execute(sql`
        UPDATE dealer_lead_commercials
           SET onboarding_fee = ${c.onboarding_fee},
               fee_waived_reason = ${c.fee_waived_reason ?? null},
               expected_batteries_per_month = ${c.batteries_per_month},
               expected_finance_files_per_month = ${c.finance_files_per_month}
         WHERE commercial_id = ${commercialId}
    `);
}
