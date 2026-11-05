// ID 224 point 6 — leads whose own events are dated BEFORE the lead was
// created (the 3 Nov check found 182 on live: sales-ready / assigned / first
// attempt before "Created on"). Read-only: lists them by where the lead came
// from and which event came first, to show which path creates them late.
//
//   node --import tsx --env-file=.env.local scripts/verify-leads-created-after-events.ts
//
// No code path rewrites dealer_leads.created_at (checked 5 Nov: every insert
// stamps now(); merges and re-activation leave it alone). The suspect is a lead
// created from an event that happened earlier — NeoDove inbound creates the lead
// when a call/lead event arrives and records the touchpoint at the event's own
// time (neodove/inbound.ts: performedAt = event.occurredAt), e.g. a replay.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`DB host: ${host}`);
    // dealer_leads.created_at is a timestamp without time zone holding UTC.
    const base = sql`
        WITH l AS (
            SELECT dl.id, (dl.created_at AT TIME ZONE 'UTC') AS created,
                   to_jsonb(dl) ->> 'source_door' AS door, dl.source,
                   (to_jsonb(dl) ->> 'sales_ready_at')::timestamptz AS sales_ready,
                   dl.assigned_at AS assigned
              FROM dealer_leads dl
        ),
        first_tp AS (
            SELECT DISTINCT ON (t.dealer_lead_id) t.dealer_lead_id, t.performed_at, t.touchpoint_type,
                   t.external_system, t.created_at AS written_at
              FROM lead_touchpoints t
             ORDER BY t.dealer_lead_id, t.performed_at
        ),
        bad AS (
            SELECT l.*, f.performed_at AS first_event, f.touchpoint_type AS first_type,
                   f.external_system, f.written_at,
                   (f.performed_at < l.created - interval '1 minute') AS event_first,
                   (l.sales_ready < l.created - interval '1 minute') AS ready_first,
                   (l.assigned < l.created - interval '1 minute') AS assigned_first
              FROM l LEFT JOIN first_tp f ON f.dealer_lead_id = l.id
             WHERE f.performed_at < l.created - interval '1 minute'
                OR l.sales_ready < l.created - interval '1 minute'
                OR l.assigned < l.created - interval '1 minute'
        )`;
    const total = (await db.execute(sql`${base} SELECT count(*)::int AS n FROM bad`)) as unknown as Array<{ n: number }>;
    console.log(`Leads with an event before their own creation: ${total[0]?.n ?? 0}`);

    const bySource = (await db.execute(sql`${base}
        SELECT COALESCE(door, '(no door)') AS door, COALESCE(source, '(none)') AS source,
               COALESCE(first_type, '(no touchpoint)') AS first_event, COALESCE(external_system, '') AS via,
               count(*)::int AS n,
               count(*) FILTER (WHERE event_first)::int AS event_first,
               count(*) FILTER (WHERE ready_first)::int AS ready_first,
               count(*) FILTER (WHERE assigned_first)::int AS assigned_first,
               round(avg(EXTRACT(EPOCH FROM (created - LEAST(first_event, sales_ready, assigned))) / 3600)::numeric, 1) AS avg_hours_early
          FROM bad GROUP BY 1, 2, 3, 4 ORDER BY n DESC LIMIT 25`)) as unknown as Array<Record<string, unknown>>;
    console.table(bySource);

    const sample = (await db.execute(sql`${base}
        SELECT id, created, first_event, first_type, external_system, written_at, sales_ready, assigned
          FROM bad ORDER BY created DESC LIMIT 8`)) as unknown as Array<Record<string, unknown>>;
    console.log("Latest examples (written_at = when the touchpoint row was written):");
    console.table(sample);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
