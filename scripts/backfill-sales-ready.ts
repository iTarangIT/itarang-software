/**
 * Tracker ID 82 — backfill the Sales-ready event for leads that became
 * sales-ready BEFORE the event existed (review 30 Sep, point 3: "existing
 * AI-qualified unowned leads aren't in the queue").
 *
 *   node --import tsx --env-file=.env.local scripts/backfill-sales-ready.ts            dry run
 *   node --import tsx --env-file=.env.local scripts/backfill-sales-ready.ts --apply
 *   node --import tsx --env-file=.env.local scripts/backfill-sales-ready.ts --undo <file>
 *
 * WHICH LEADS. Active leads with no sales_ready_at for which one of the live
 * events demonstrably happened. The EARLIEST one wins, as it does live:
 *
 *   rep_created      Entered via = Rep-created or WhatsApp Assistant
 *                    (source_door, ID 81)                            → created_at
 *   inbound_inquiry  the same, when Found via = Inbound call          → created_at
 *   claimed_by_rep   the first "lead claimed" touchpoint              → its time
 *   neodove_pickup   the first owner hop, by the agent themself,
 *                    from NeoDove                                     → its time
 *   admin_assigned   any other first owner hop; or the lead simply HAS
 *                    an owner with no hop on record                   → the hop's time,
 *                                                                       else assigned_at,
 *                                                                       else created_at
 *   ai_qualified     the AI call marked it qualified (current_status) → the first call
 *                                                                       banded qualified,
 *                                                                       else the last AI
 *                                                                       call, else updated_at
 *
 * WHAT IS WRITTEN. dealer_leads.sales_ready_at + sales_ready_reason, and one
 * "sales_ready" touchpoint per lead dated at the event and marked
 * "(backfilled)", so the lead's timeline shows it. The touchpoint is inserted
 * directly: it has no performer and does not move last_touchpoint_at or the
 * idle clock. Nothing else on the lead changes.
 *
 * REVERSIBLE. --apply writes the lead ids and touchpoint ids to
 * scripts/_backfill-sales-ready.<database>.<timestamp>.json; --undo <file>
 * clears exactly those stamps and deletes exactly those touchpoints.
 * Idempotent: a second run finds nothing to do.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { awaitingAssignment, daysAwaitingAssignment, AWAITING_ASSIGNMENT_OVERDUE_DAYS, salesReadyReasonLabel } from "@/lib/leads/salesReady";

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);

/** One row per lead to stamp: id, at, reason. Earliest candidate wins. */
const CANDIDATES = sql`
    WITH base AS (
        SELECT dl.id, dl.created_at, dl.updated_at, dl.assigned_at, dl.current_owner_id, dl.current_status,
               to_jsonb(dl) ->> 'source_door' AS source_door,
               to_jsonb(dl) ->> 'source_origin' AS source_origin
          FROM dealer_leads dl
         WHERE dl.is_active IS NOT FALSE
           AND (to_jsonb(dl) ->> 'sales_ready_at') IS NULL
    ),
    hop AS (
        -- the first time the lead got an owner
        SELECT DISTINCT ON (t.dealer_lead_id)
               t.dealer_lead_id AS id, t.performed_at AS at,
               CASE WHEN t.touchpoint_type = 'lead_claimed' THEN 'claimed_by_rep'
                    WHEN t.external_system = 'neodove' AND t.performed_by IS NOT NULL
                         AND t.performed_by = t.to_owner_id THEN 'neodove_pickup'
                    ELSE 'admin_assigned' END AS reason
          FROM lead_touchpoints t
          JOIN base b ON b.id = t.dealer_lead_id
         WHERE t.touchpoint_type IN ('lead_claimed', 'lead_assigned', 'ownership_transfer', 'asm_transfer')
            OR t.to_owner_id IS NOT NULL
         ORDER BY t.dealer_lead_id, t.performed_at ASC
    ),
    ai AS (
        SELECT b.id,
               COALESCE(
                   (SELECT MIN(COALESCE(a.ended_at, a.started_at, a.created_at)) FROM ai_call_logs a
                     WHERE a.lead_id = b.id AND lower(COALESCE(a.human_band, a.band, '')) = 'qualified'),
                   (SELECT MAX(t.performed_at) FROM lead_touchpoints t
                     WHERE t.dealer_lead_id = b.id AND t.touchpoint_type = 'ai_call'),
                   (SELECT MAX(COALESCE(a.ended_at, a.started_at, a.created_at)) FROM ai_call_logs a WHERE a.lead_id = b.id),
                   b.updated_at, b.created_at) AS at
          FROM base b
         WHERE b.current_status = 'qualified'
    ),
    cand AS (
        SELECT id, created_at AS at,
               CASE WHEN source_origin = 'inbound_call' THEN 'inbound_inquiry' ELSE 'rep_created' END AS reason,
               1 AS pref
          FROM base WHERE source_door IN ('rep_create', 'whatsapp_assistant')
        UNION ALL SELECT id, at, reason, 2 FROM hop
        UNION ALL SELECT id, at, 'ai_qualified', 3 FROM ai
        UNION ALL
        -- has an owner, but no hop was ever recorded
        SELECT b.id, COALESCE(b.assigned_at, b.created_at), 'admin_assigned', 4
          FROM base b
         WHERE b.current_owner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hop h WHERE h.id = b.id)
    )
    SELECT DISTINCT ON (id) id, at, reason
      FROM cand
     WHERE at IS NOT NULL
     ORDER BY id, at ASC, pref ASC
`;

async function main() {
    const apply = process.argv.includes("--apply");
    const undoAt = process.argv.indexOf("--undo");
    const database = new URL(process.env.DATABASE_URL!).host.split(".")[0];
    console.log("database:", database);

    if (undoAt > -1) {
        const file = process.argv[undoAt + 1];
        if (!file) throw new Error("usage: --undo <file written by --apply>");
        const saved = JSON.parse(readFileSync(file, "utf8")) as { database: string; rows: Array<{ id: string; touchpoint_id: string }> };
        if (saved.database !== database) throw new Error(`that file is for ${saved.database}, this is ${database}`);
        let leads = 0;
        let touchpoints = 0;
        await db.transaction(async (tx) => {
            for (let i = 0; i < saved.rows.length; i += 1000) {
                const chunk = saved.rows.slice(i, i + 1000);
                const ids = sql.join(chunk.map((r) => sql`${r.id}`), sql`, `);
                const tps = sql.join(chunk.map((r) => sql`${r.touchpoint_id}`), sql`, `);
                touchpoints += ((await tx.execute(sql`
                    DELETE FROM lead_touchpoints WHERE touchpoint_id::text IN (${tps}) AND touchpoint_type = 'sales_ready'
                    RETURNING touchpoint_id`)) as unknown as Row[]).length;
                leads += ((await tx.execute(sql`
                    UPDATE dealer_leads SET sales_ready_at = NULL, sales_ready_reason = NULL WHERE id IN (${ids})
                    RETURNING id`)) as unknown as Row[]).length;
            }
        });
        console.log(`undone: ${leads} leads un-stamped, ${touchpoints} backfilled touchpoints removed`);
        return;
    }

    const before = (await db.execute(sql`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE ${daysAwaitingAssignment()} >= ${AWAITING_ASSIGNMENT_OVERDUE_DAYS})::int AS overdue
          FROM dealer_leads dl WHERE ${awaitingAssignment()}`)) as unknown as Row[];

    const summary = (await db.execute(sql`
        WITH c AS (${CANDIDATES})
        SELECT c.reason,
               COUNT(*)::int AS leads,
               COUNT(*) FILTER (WHERE dl.current_owner_id IS NULL)::int AS unowned,
               COUNT(*) FILTER (WHERE dl.current_owner_id IS NULL AND dl.is_active IS NOT FALSE
                                  AND COALESCE(dl.lead_status, '') NOT IN ('Won', 'Converted', 'Lost')
                                  AND (to_jsonb(dl) ->> 'contactability') IS NULL)::int AS into_queue,
               COUNT(*) FILTER (WHERE dl.current_owner_id IS NULL AND dl.is_active IS NOT FALSE
                                  AND COALESCE(dl.lead_status, '') NOT IN ('Won', 'Converted', 'Lost')
                                  AND (to_jsonb(dl) ->> 'contactability') IS NULL
                                  AND c.at < now() - make_interval(days => ${AWAITING_ASSIGNMENT_OVERDUE_DAYS}))::int AS into_queue_overdue,
               MIN(c.at)::date::text AS earliest, MAX(c.at)::date::text AS latest
          FROM c JOIN dealer_leads dl ON dl.id = c.id
         GROUP BY c.reason ORDER BY 2 DESC`)) as unknown as Row[];

    const total = summary.reduce((a, r) => a + num(r.leads), 0);
    const intoQueue = summary.reduce((a, r) => a + num(r.into_queue), 0);
    const intoOverdue = summary.reduce((a, r) => a + num(r.into_queue_overdue), 0);
    console.log(`\n${total} leads became sales-ready before the event existed:`);
    for (const r of summary) {
        console.log(
            `  ${String(r.reason).padEnd(15)} ${String(num(r.leads)).padStart(6)} leads (${salesReadyReasonLabel(String(r.reason))}), ` +
                `${r.earliest} … ${r.latest}; ${num(r.unowned)} have no owner now, ${num(r.into_queue)} would enter Ready to assign`,
        );
    }
    console.log(
        `\nReady to assign now: ${num(before[0]?.total)} (${num(before[0]?.overdue)} waiting ${AWAITING_ASSIGNMENT_OVERDUE_DAYS}+ days)` +
            ` → after: ${num(before[0]?.total) + intoQueue} (${num(before[0]?.overdue) + intoOverdue} waiting ${AWAITING_ASSIGNMENT_OVERDUE_DAYS}+ days — the CEO card)`,
    );

    if (!apply) {
        console.log("\ndry run — nothing written. Re-run with --apply to write.");
        return;
    }
    if (total === 0) {
        console.log("\nnothing to write.");
        return;
    }

    const written = await db.transaction(async (tx) => {
        const stamped = (await tx.execute(sql`
            WITH c AS (${CANDIDATES})
            UPDATE dealer_leads dl
               SET sales_ready_at = c.at, sales_ready_reason = c.reason
              FROM c
             WHERE dl.id = c.id AND dl.sales_ready_at IS NULL
            RETURNING dl.id, dl.sales_ready_at AS at, dl.sales_ready_reason AS reason`)) as unknown as Array<{ id: string; at: string; reason: string }>;
        const rows: Array<{ id: string; touchpoint_id: string }> = [];
        for (let i = 0; i < stamped.length; i += 500) {
            const chunk = stamped.slice(i, i + 500);
            const values = sql.join(
                chunk.map(
                    (r) =>
                        sql`(${r.id}, 'sales_ready', ${new Date(r.at).toISOString()}::timestamptz, ${`Sales-ready — ${salesReadyReasonLabel(r.reason)}. (backfilled)`}, 'system')`,
                ),
                sql`, `,
            );
            const inserted = (await tx.execute(sql`
                INSERT INTO lead_touchpoints (dealer_lead_id, touchpoint_type, performed_at, remarks, sync_method)
                VALUES ${values}
                RETURNING touchpoint_id::text AS touchpoint_id, dealer_lead_id AS id`)) as unknown as Array<{ id: string; touchpoint_id: string }>;
            rows.push(...inserted);
        }
        if (rows.length !== stamped.length) throw new Error(`stamped ${stamped.length} leads but wrote ${rows.length} touchpoints — rolled back`);
        const file = `scripts/_backfill-sales-ready.${database}.${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        writeFileSync(file, JSON.stringify({ database, written_at: new Date().toISOString(), rows }));
        console.log(`\nids of ${rows.length} leads and their touchpoints saved to ${file}`);
        return rows.length;
    });
    const [left] = (await db.execute(sql`WITH c AS (${CANDIDATES}) SELECT COUNT(*)::int AS n FROM c`)) as unknown as Row[];
    console.log(`stamped ${written} leads; ${num(left.n)} still unstamped (expected 0)`);
    if (num(left.n) !== 0) process.exitCode = 1;
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode ?? 0));
