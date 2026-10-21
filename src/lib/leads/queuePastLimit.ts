// IDs 85 / 86 (18 Oct rows 34 + export gap) — the queues' "Past a limit"
// filter and chip, shared by the ISR and ASM list routes AND their exports, so
// a sheet downloaded with the chip on holds exactly the leads the screen shows,
// each naming the limits it passed.

import { sql, type SQL } from "drizzle-orm";
import { hasLeadClocks, limitsPastByLead, pastALimitSql } from "@/lib/leads/clocks";
import { limitChipLabel } from "@/lib/leads/limitEventLabels";
import { timeLimitDef } from "@/lib/timeLimits/registry";

/**
 * The SQL predicate for `?past_limit=1` (over `dl.id`), or null when the param
 * is absent. Where lead_clocks is missing it matches nothing rather than failing.
 */
export async function pastLimitFilter(params: URLSearchParams): Promise<SQL | null> {
    if (params.get("past_limit") !== "1") return null;
    return (await hasLeadClocks()) ? pastALimitSql(sql`dl.id`) : sql`FALSE`;
}

/**
 * Lead id → the chip labels of every limit it is past (e.g. "Past: Field visit
 * (3 working days)"). Fail-tolerant: a failure drops the decoration, never the
 * list or the sheet.
 */
export async function pastLimitLabelsByLead(ids: string[]): Promise<Map<string, string[]>> {
    const byLead = await limitsPastByLead(ids).catch(
        () => new Map<string, Array<{ clock: string; limit_key: string; limit_value: number }>>(),
    );
    const out = new Map<string, string[]>();
    for (const [id, events] of byLead) {
        out.set(
            id,
            events.map((e) => limitChipLabel({ ...e, limit_unit: timeLimitDef(e.limit_key)?.unit })),
        );
    }
    return out;
}
