/**
 * Scrap sourced (kg) — ONE definition for the CEO control tower's buyback tile
 * and the Daily Sales email's "Scrap sourced (kg)" row (tracker ID 9):
 *
 *   Σ quantity × unit_weight_kg over every line of every request that logged
 *   `complete_pickup` in [from, toExcl) — IST calendar days, end exclusive.
 *
 * A request counts once however many pickups it logged in the window. Lines
 * with no weight add 0 (the Buyback Daily mail shows that under-count beside
 * its own kg figure).
 *
 * `exec` defaults to the app's db, imported lazily so a caller that passes its
 * own handle (or a unit test) never needs DATABASE_URL.
 */
import { sql } from "drizzle-orm";

type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

export async function scrapKgSourced(from: string, toExcl: string, exec?: Exec): Promise<number> {
    const e: Exec = exec ?? ((await import("@/lib/db")).db as unknown as Exec);
    const r = (await e.execute(sql`
        SELECT COALESCE(SUM(l.quantity * l.unit_weight_kg), 0) AS kg
          FROM (SELECT DISTINCT al.request_id FROM buyback_activity_log al
                 WHERE al.action = 'complete_pickup'
                   AND (al.created_at AT TIME ZONE 'Asia/Kolkata')::date >= ${from}::date
                   AND (al.created_at AT TIME ZONE 'Asia/Kolkata')::date < ${toExcl}::date) p
          JOIN buyback_batches bt ON bt.request_id = p.request_id
          JOIN buyback_lines l ON l.batch_id = bt.id
    `)) as Array<{ kg: string | number | null }>;
    return Number(r[0]?.kg ?? 0);
}
