// Per-user turn lease (BRD §8.2 "per-user lock"; plan D2).
//
// Two quick messages from one rep must run one after the other, never in
// parallel on one conversation. The BRD names pg_advisory_xact_lock, but that
// holds an open transaction — a pinned pooled connection — for the whole agent
// turn (LLM + tools, seconds), and the app pool is max 5 per process. So the
// lock is a LEASE on the user's assistant_conversations row instead:
//
//   acquire  UPDATE … SET lease_token = $t, lease_until = now() + LEASE
//             WHERE user_id = $u AND (lease_until IS NULL OR lease_until < now())
//            — atomic compare-and-set; retried every POLL_MS up to WAIT_MS.
//   release  UPDATE … SET lease_token = NULL, lease_until = NULL
//             WHERE user_id = $u AND lease_token = $t  (never frees someone else's)
//   crash    the lease simply expires after LEASE_MS.
//
// LEASE_MS (90 s) is double the agent's hard turn deadline (45 s), so a live
// turn never outlives its lease. Order between two waiting messages is not
// strictly FIFO; what is guaranteed is that they never overlap.

import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const LEASE_MS = 90_000;
export const WAIT_MS = 60_000;
export const POLL_MS = 300;

export type LeaseOutcome<T> = { ok: true; value: T } | { ok: false; reason: "busy" };

export async function withUserLease<T>(
    userId: string,
    fn: () => Promise<T>,
    opts: { leaseMs?: number; waitMs?: number; pollMs?: number; channel?: string } = {},
): Promise<LeaseOutcome<T>> {
    const leaseMs = opts.leaseMs ?? LEASE_MS;
    const waitMs = opts.waitMs ?? WAIT_MS;
    const pollMs = opts.pollMs ?? POLL_MS;
    const channel = opts.channel ?? "whatsapp";
    const token = crypto.randomUUID();

    await db.execute(sql`
        INSERT INTO assistant_conversations (user_id, channel)
        VALUES (${userId}::uuid, ${channel})
        ON CONFLICT (user_id, channel) DO NOTHING
    `);

    const giveUpAt = Date.now() + waitMs;
    for (;;) {
        const got = await db.execute<{ id: string }>(sql`
            UPDATE assistant_conversations
               SET lease_token = ${token}::uuid,
                   lease_until = now() + make_interval(secs => ${leaseMs / 1000})
             WHERE user_id = ${userId}::uuid AND channel = ${channel}
               AND (lease_until IS NULL OR lease_until < now())
            RETURNING id
        `);
        if (got.length > 0) break;
        if (Date.now() >= giveUpAt) return { ok: false, reason: "busy" };
        await new Promise((r) => setTimeout(r, pollMs));
    }

    try {
        return { ok: true, value: await fn() };
    } finally {
        await db.execute(sql`
            UPDATE assistant_conversations
               SET lease_token = NULL, lease_until = NULL
             WHERE user_id = ${userId}::uuid AND channel = ${channel} AND lease_token = ${token}::uuid
        `);
    }
}
