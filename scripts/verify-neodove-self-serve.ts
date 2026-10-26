// NeoDove self-serve (26 Oct): a campaign wired by a pasted URL, then deleted.
// SANDBOX ONLY — creates a throwaway campaign and removes it again.
//
//   node --import tsx --env-file=.env.local scripts/verify-neodove-self-serve.ts
//
// (Needs APP_SECRETS_ENC_KEY, or a throwaway one exported for the run — see
// verify-a32-endpoint-store.ts.) Creates a campaign row, stores a test URL
// through saveCampaignEndpoint, checks the push resolver returns it, adds one
// sync event and one lead link pointing at the campaign, then runs the real
// deleteNeodoveCampaign and checks: campaign gone, sealed URL gone, link gone
// (cascade), sync event kept with a NULL campaign. Cleans up the sync event.
// Refuses on database-2 (prod).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    DB_ENDPOINT_REF,
    endpointStoreStatus,
    isCampaignWired,
    resolveCampaignEndpoint,
    saveCampaignEndpoint,
} from "@/lib/neodove/endpointStore";
import { deleteNeodoveCampaign } from "@/lib/neodove/deleteCampaign";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
}

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").host;
    console.log(`DB host: ${host}\n`);
    if (host.startsWith("database-2.")) throw new Error("refusing to write on prod (database-2)");
    const status = await endpointStoreStatus();
    check(`endpoint store ready (${status.reason ?? "ok"})`, status.ready);
    if (!status.ready) process.exit(1);

    const id = `NDC-VERIFY-${Date.now()}`;
    const url = `https://api.neodove.com/integration/custom/self-serve-test-${Date.now()}/leads`;
    let eventId: string | null = null;
    try {
        await db.execute(sql`
            INSERT INTO neodove_campaigns (id, name, status) VALUES (${id}, ${"verify self-serve " + id}, 'draft')`);
        await saveCampaignEndpoint({ campaignId: id, kind: "push", url, actorId: "00000000-0000-0000-0000-000000000000" });
        check("pasted URL resolves for push", (await resolveCampaignEndpoint(DB_ENDPOINT_REF, id)) === url);
        check("campaign reads as wired", await isCampaignWired(DB_ENDPOINT_REF, id));

        const [lead] = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM dealer_leads ORDER BY created_at DESC LIMIT 1`));
        if (lead) {
            await db.execute(sql`
                INSERT INTO neodove_lead_links (dealer_lead_id, neodove_campaign_id, push_status)
                VALUES (${lead.id}, ${id}, 'pending')`);
        }
        const [ev] = rowsOf<{ id: string }>(
            await db.execute(sql`
                INSERT INTO neodove_sync_events (direction, event_type, neodove_campaign_id, request_payload)
                VALUES ('outbound', 'verify_self_serve', ${id}, '{}'::jsonb)
                RETURNING id::text AS id`),
        );
        eventId = ev?.id ?? null;

        const r = await deleteNeodoveCampaign(id);
        check("delete succeeded", r.ok, r);
        if (r.ok && lead) check("reported 1 removed link", r.removedLinks === 1, r.removedLinks);

        const [left] = rowsOf<{ c: number; e: number; l: number }>(
            await db.execute(sql`
                SELECT (SELECT COUNT(*) FROM neodove_campaigns WHERE id = ${id})::int AS c,
                       (SELECT COUNT(*) FROM neodove_campaign_endpoints WHERE campaign_id = ${id})::int AS e,
                       (SELECT COUNT(*) FROM neodove_lead_links WHERE neodove_campaign_id = ${id})::int AS l`),
        );
        check("campaign row gone", left.c === 0);
        check("sealed URL gone", left.e === 0);
        check("lead link gone (cascade)", left.l === 0);
        if (eventId) {
            const [e] = rowsOf<{ cid: string | null }>(
                await db.execute(sql`SELECT neodove_campaign_id AS cid FROM neodove_sync_events WHERE id::text = ${eventId}`),
            );
            check("sync event kept, campaign set NULL", Boolean(e) && e.cid === null);
        }
        check("second delete says not found", (await deleteNeodoveCampaign(id)).ok === false);
    } finally {
        if (eventId) await db.execute(sql`DELETE FROM neodove_sync_events WHERE id::text = ${eventId}`);
        await db.execute(sql`DELETE FROM neodove_campaign_endpoints WHERE campaign_id = ${id}`);
        await db.execute(sql`DELETE FROM neodove_campaigns WHERE id = ${id}`);
    }

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
