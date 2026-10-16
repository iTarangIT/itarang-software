// A32 — replay NeoDove call events that reached the WRONG CRM into the right one.
//
// Found 16 Oct: from 6 Oct NeoDove's Custom Integration webhook has been
// posting to the SANDBOX CRM, so prod stopped receiving calls (Nidhi showed
// ~1 call on 13 Oct while sandbox had 198 for CRM_NEODOVE_1 (Nidhi)).
// After NeoDove is pointed back at https://crm.itarang.com/api/neodove/webhook,
// this sends the events prod missed through prod's own webhook, so they are
// handled exactly like live ones (lead match, touchpoint, disposition,
// owner, interest). The webhook is idempotent on NeoDove's event id, so a
// re-run, or an event prod already has, changes nothing.
//
//   SOURCE = the database that received the events (DATABASE_URL of the env file)
//   TARGET = the webhook URL + the TARGET's NEODOVE_WEBHOOK_SECRET
//
//   node --import tsx --env-file=.env.local scripts/replay-neodove-events.ts \
//        --since=2026-10-06 --to=https://crm.itarang.com/api/neodove/webhook
//        (dry run: lists what would be sent, sends nothing)
//   NEODOVE_TARGET_SECRET=<prod NEODOVE_WEBHOOK_SECRET> … --commit
//
// Sends one event at a time, 150 ms apart, in the order they first arrived.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

const args = process.argv.slice(2);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const COMMIT = args.includes("--commit");
const SINCE = opt("since") ?? "2026-10-06";
const TO = opt("to");
const LIMIT = opt("max") ? Number(opt("max")) : Infinity;

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const source = new URL(process.env.DATABASE_URL ?? "postgres://unset").host.split(".")[0];
    if (!TO || !/^https:\/\/[^/]+\/api\/neodove\/webhook$/.test(TO)) {
        throw new Error("--to=https://<crm host>/api/neodove/webhook is required");
    }
    const secret = process.env.NEODOVE_TARGET_SECRET;
    if (COMMIT && !secret) throw new Error("NEODOVE_TARGET_SECRET (the TARGET's NEODOVE_WEBHOOK_SECRET) is required with --commit");
    console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} · from ${source} since ${SINCE} → ${TO}\n`);

    const events = rowsOf<{ id: string; external_event_id: string | null; created_at: string; payload: Record<string, unknown> }>(
        await db.execute(sql`
            SELECT e.id::text AS id, e.external_event_id, e.created_at::text AS created_at, e.request_payload AS payload
              FROM neodove_sync_events e
             WHERE e.direction = 'inbound' AND e.created_at >= ${SINCE}::date AND e.request_payload IS NOT NULL
             ORDER BY e.created_at, e.id`),
    );
    const byCampaign = new Map<string, number>();
    for (const e of events) {
        const c = String((e.payload as { campaign_name?: string }).campaign_name ?? "(none)");
        byCampaign.set(c, (byCampaign.get(c) ?? 0) + 1);
    }
    console.log(`${events.length} inbound event(s) on ${source} since ${SINCE}:`);
    for (const [c, n] of [...byCampaign].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${c}`);
    if (!COMMIT) {
        console.log("\nDry run — nothing sent. Add --commit with NEODOVE_TARGET_SECRET to send.");
        process.exit(0);
    }

    let sent = 0, ok = 0, dup = 0, failed = 0;
    for (const e of events.slice(0, LIMIT)) {
        sent++;
        try {
            const r = await fetch(TO, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
                body: JSON.stringify(e.payload),
            });
            const body = await r.text();
            if (r.ok) {
                if (/duplicate|already/i.test(body)) dup++;
                else ok++;
            } else {
                failed++;
                console.log(`! ${e.external_event_id ?? e.id} → ${r.status} ${body.slice(0, 160)}`);
            }
        } catch (err) {
            failed++;
            console.log(`! ${e.external_event_id ?? e.id} → ${err instanceof Error ? err.message : String(err)}`);
        }
        if (sent % 100 === 0) console.log(`  … ${sent}/${events.length}`);
        await sleep(150);
    }
    console.log(`\nsent ${sent} · accepted ${ok} · already there ${dup} · failed ${failed}`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
