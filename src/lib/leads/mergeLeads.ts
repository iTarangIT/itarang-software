// ID 248 — merge two dealer leads that are one dealer (same number, stored once with and once
// without +91). The OLDER lead is kept with its history; everything that points at the newer
// copy is moved onto it; a visit logged on both copies the same day then counts once; the
// copy is closed Lost with reason duplicate_lead. Server only.
//
// What "everything" is: every column named dealer_lead_id or lead_id in a public base table
// (found in the catalog at run time, so a table added later is not missed). Lead ids are
// unique strings ("DL-…", "L-…"), so a customer-loan table's lead_id never equals a dealer
// lead's id and is untouched. Each table moves inside its own SAVEPOINT: a unique clash
// (e.g. the same lead twice in one campaign) leaves THAT table's rows on the copy instead of
// failing the merge, and is reported. Nothing is deleted.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { markLeadLost } from "@/lib/leads/markLost";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Tables whose rows stay on the copy: the lead rows and the merge record, and the copy's
 * OWN lifecycle (status / interest / field history, time-limit events and clocks,
 * assignment logs) and audit logs. Moving those would add the copy's status changes to the
 * kept lead's and count them twice (Leads in, Lost, Won by history). Activity — calls,
 * visits, quotes, documents, campaigns, callbacks — moves.
 */
const SKIP_TABLES = new Set([
    "dealer_leads",
    "duplicate_merge_requests",
    "dealer_lead_status_history",
    "dealer_lead_interest_history",
    "dealer_lead_field_changes",
    "lead_limit_events",
    "lead_clocks",
    "assignment_change_logs",
    "lead_assignments",
    "assistant_actions",
    "file_access_log",
    "notifications",
]);
/** Profile fields the kept lead takes from the copy only when its own is empty. */
const FILL_FIELDS = ["shop_name", "dealer_name", "city", "state", "district", "pincode", "address", "email", "gstin", "owner_name"];

export type MergeLead = {
    id: string;
    phone: string | null;
    name: string | null;
    lead_status: string | null;
    owner_name: string | null;
    created_at: string;
};

export type MergePlan = {
    keep: MergeLead;
    drop: MergeLead;
    /** Rows that will move, per table.column (only non-zero). */
    moves: Array<{ table: string; column: string; rows: number }>;
    /** Done visits on the copy dated a day the kept lead already has a done visit: they will count once. */
    sameDayVisits: number;
};

export type MergeResult = MergePlan & {
    moved: Array<{ table: string; column: string; rows: number }>;
    keptOnCopy: Array<{ table: string; column: string; reason: string }>;
    filled: string[];
    visitsCancelled: number;
};

const last10 = (p: string | null) => (p ?? "").replace(/\D/g, "").slice(-10);

async function referencingColumns(tx: Tx | typeof db): Promise<Array<{ table: string; column: string }>> {
    const rows = (await tx.execute(sql`
        SELECT c.table_name AS table, c.column_name AS column
          FROM information_schema.columns c
          JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
           AND c.column_name IN ('dealer_lead_id', 'lead_id')
           AND c.data_type IN ('text', 'character varying')
         ORDER BY 1, 2
    `)) as unknown as Array<{ table: string; column: string }>;
    return rows.filter((r) => !SKIP_TABLES.has(r.table));
}

async function loadLead(tx: Tx | typeof db, id: string): Promise<MergeLead | null> {
    const rows = (await tx.execute(sql`
        SELECT dl.id, dl.phone, COALESCE(dl.shop_name, dl.dealer_name) AS name, dl.lead_status,
               u.name AS owner_name, dl.created_at::text AS created_at
          FROM dealer_leads dl LEFT JOIN users u ON u.id::text = dl.current_owner_id
         WHERE dl.id = ${id}
    `)) as unknown as MergeLead[];
    return rows[0] ?? null;
}

function quoteIdent(name: string): string {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected identifier ${name}`);
    return `"${name}"`;
}

/** Checks both leads exist, share the last 10 digits, and that `keep` is the older one. */
function validate(keep: MergeLead | null, drop: MergeLead | null, keepId: string, dropId: string): asserts keep is MergeLead {
    if (!keep) throw new Error(`lead ${keepId} not found`);
    if (!drop) throw new Error(`lead ${dropId} not found`);
    if (keep.id === drop.id) throw new Error("the two ids are the same lead");
    if (last10(keep.phone).length !== 10 || last10(keep.phone) !== last10(drop.phone)) {
        throw new Error(`numbers differ on the last 10 digits (${last10(keep.phone)} vs ${last10(drop.phone)}): not merged`);
    }
    if (new Date(keep.created_at) > new Date(drop.created_at)) {
        throw new Error(`${keep.id} is newer than ${drop.id}: keep the OLDER lead (swap the two ids)`);
    }
}

/** Read-only: what a merge would move. */
export async function planMerge(keepId: string, dropId: string): Promise<MergePlan> {
    const keep = await loadLead(db, keepId);
    const drop = await loadLead(db, dropId);
    validate(keep, drop, keepId, dropId);
    const moves: MergePlan["moves"] = [];
    for (const { table, column } of await referencingColumns(db)) {
        const r = (await db.execute(
            sql`SELECT count(*)::int AS n FROM ${sql.raw(quoteIdent(table))} WHERE ${sql.raw(quoteIdent(column))} = ${dropId}`,
        )) as unknown as Array<{ n: number }>;
        if (r[0]?.n) moves.push({ table, column, rows: r[0].n });
    }
    const same = (await db.execute(sql`
        SELECT count(*)::int AS n FROM lead_visits d
         WHERE d.dealer_lead_id = ${dropId} AND d.visit_status = 'visited'
           AND EXISTS (SELECT 1 FROM lead_visits k WHERE k.dealer_lead_id = ${keepId}
                        AND k.visit_status = 'visited' AND k.actual_visit_date = d.actual_visit_date)
    `)) as unknown as Array<{ n: number }>;
    return { keep, drop: drop!, moves, sameDayVisits: same[0]?.n ?? 0 };
}

/** Merges `dropId` into `keepId` in one transaction. `actor` is the admin running it. */
export async function mergeDealerLeads(input: { keepId: string; dropId: string; actor: { id: string; role: string } }): Promise<MergeResult> {
    const plan = await planMerge(input.keepId, input.dropId);
    const { keepId, dropId } = input;
    return db.transaction(async (tx) => {
        // Lock both leads for the duration.
        await tx.execute(sql`SELECT id FROM dealer_leads WHERE id IN (${keepId}, ${dropId}) FOR UPDATE`);

        // Done visits on the copy, dated a day the kept lead already has one: they will count once.
        const dupVisits = (await tx.execute(sql`
            SELECT d.visit_id::text AS visit_id,
                   (SELECT k.visit_id::text FROM lead_visits k WHERE k.dealer_lead_id = ${keepId}
                       AND k.visit_status = 'visited' AND k.actual_visit_date = d.actual_visit_date LIMIT 1) AS kept_visit
              FROM lead_visits d
             WHERE d.dealer_lead_id = ${dropId} AND d.visit_status = 'visited'
               AND EXISTS (SELECT 1 FROM lead_visits k WHERE k.dealer_lead_id = ${keepId}
                            AND k.visit_status = 'visited' AND k.actual_visit_date = d.actual_visit_date)
        `)) as unknown as Array<{ visit_id: string; kept_visit: string }>;

        const moved: MergeResult["moved"] = [];
        const keptOnCopy: MergeResult["keptOnCopy"] = [];
        for (const { table, column } of await referencingColumns(tx)) {
            // A nested transaction = the driver's own SAVEPOINT (postgres.js does not
            // recover from a raw ROLLBACK TO SAVEPOINT): a unique clash rolls back only this
            // table's move and the merge carries on.
            try {
                const r = await tx.transaction(
                    async (sp) =>
                        (await sp.execute(
                            sql`UPDATE ${sql.raw(quoteIdent(table))} SET ${sql.raw(quoteIdent(column))} = ${keepId} WHERE ${sql.raw(quoteIdent(column))} = ${dropId} RETURNING 1 AS x`,
                        )) as unknown as unknown[],
                );
                if (r.length) moved.push({ table, column, rows: r.length });
            } catch (err) {
                const reason = err instanceof Error ? err.message.split("\n")[0]! : String(err);
                keptOnCopy.push({ table, column, reason });
            }
        }

        // One visit, counted once: the copy's same-day duplicate is cancelled, not deleted.
        for (const v of dupVisits) {
            await tx.execute(sql`
                UPDATE lead_visits
                   SET visit_status = 'cancelled',
                       visit_remarks = concat_ws(' ', NULLIF(visit_remarks, ''), ${`[Duplicate of visit ${v.kept_visit}: lead ${dropId} merged into ${keepId}]`}::text),
                       updated_at = NOW()
                 WHERE visit_id::text = ${v.visit_id}
            `);
        }

        // The kept lead takes the copy's profile fields only where its own are empty.
        const present = (await tx.execute(sql`
            SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'dealer_leads'
               AND column_name IN (${sql.join(FILL_FIELDS.map((f) => sql`${f}`), sql`, `)})
        `)) as unknown as Array<{ column_name: string }>;
        const filled: string[] = [];
        for (const { column_name: col } of present) {
            const c = sql.raw(quoteIdent(col));
            const r = (await tx.execute(sql`
                UPDATE dealer_leads k SET ${c} = d.${c}, updated_at = NOW()
                  FROM dealer_leads d
                 WHERE k.id = ${keepId} AND d.id = ${dropId}
                   AND (k.${c} IS NULL OR k.${c}::text = '') AND d.${c} IS NOT NULL AND d.${c}::text <> ''
                RETURNING 1 AS x
            `)) as unknown as unknown[];
            if (r.length) filled.push(col);
        }

        // A record on both leads, outside the activity feed (no idle-clock effect).
        await tx.execute(sql`
            INSERT INTO dealer_lead_field_changes (dealer_lead_id, field, old_value, new_value, changed_by)
            VALUES (${keepId}, 'merged_from', ${dropId}, ${keepId}, ${input.actor.id}),
                   (${dropId}, 'merged_into', ${dropId}, ${keepId}, ${input.actor.id})
        `);

        // The copy is closed: Lost, duplicate_lead (high impact, confirmed by running the merge).
        await markLeadLost(
            {
                leadId: dropId,
                actor: input.actor,
                reason: "duplicate_lead",
                notes: `Same dealer as ${keepId} (same number). History moved there (ID 248 merge).`,
                confirmedHighImpact: true,
                adminOverride: true,
                closingRole: "admin",
            },
            { tx },
        );

        return { ...plan, moved, keptOnCopy, filled, visitsCancelled: dupVisits.length };
    });
}

/** Read-only (dry run): every group of leads that share the last 10 digits of their number. */
export async function duplicatePhoneGroups(): Promise<
    Array<{ digits: string; leads: Array<MergeLead & { visits: number; touchpoints: number }> }>
> {
    const rows = (await db.execute(sql`
        WITH keyed AS (
            SELECT dl.id, right(regexp_replace(dl.phone, '[^0-9]', '', 'g'), 10) AS digits
              FROM dealer_leads dl
             WHERE length(regexp_replace(COALESCE(dl.phone, ''), '[^0-9]', '', 'g')) >= 10
        ), dup AS (
            SELECT digits FROM keyed GROUP BY digits HAVING count(*) > 1
        )
        SELECT k.digits, dl.id, dl.phone, COALESCE(dl.shop_name, dl.dealer_name) AS name, dl.lead_status,
               u.name AS owner_name, dl.created_at::text AS created_at,
               (SELECT count(*)::int FROM lead_visits v WHERE v.dealer_lead_id = dl.id) AS visits,
               (SELECT count(*)::int FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id) AS touchpoints
          FROM keyed k JOIN dup USING (digits)
          JOIN dealer_leads dl ON dl.id = k.id
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
         ORDER BY k.digits, dl.created_at
    `)) as unknown as Array<MergeLead & { digits: string; visits: number; touchpoints: number }>;
    const groups = new Map<string, Array<MergeLead & { visits: number; touchpoints: number }>>();
    for (const { digits, ...lead } of rows) groups.set(digits, [...(groups.get(digits) ?? []), lead]);
    return [...groups.entries()].map(([digits, leads]) => ({ digits, leads }));
}
