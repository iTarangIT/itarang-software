// A32 — the NeoDove endpoint store, end to end. SANDBOX ONLY (writes, then restores).
//
//   APP_SECRETS_ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
//   node --import tsx --env-file=.env.local scripts/verify-a32-endpoint-store.ts
//
// On one campaign: stores a test endpoint through saveCampaignEndpoint, checks
// the row holds no readable URL, the campaign now points at "DB", the push
// resolver returns the URL, the screen info shows only the last 4, another
// campaign cannot open the ciphertext — then puts the campaign's ref back and
// deletes the test row. Refuses on database-2 (prod).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    DB_ENDPOINT_REF,
    endpointStoreStatus,
    isCampaignWired,
    resolveCampaignEndpoint,
    saveCampaignEndpoint,
    storedEndpointInfo,
} from "@/lib/neodove/endpointStore";

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

    const [c] = rowsOf<{ id: string; push_endpoint_ref: string | null }>(
        await db.execute(sql`SELECT id, push_endpoint_ref FROM neodove_campaigns ORDER BY created_at DESC LIMIT 1`),
    );
    const [other] = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM neodove_campaigns WHERE id <> ${c.id} LIMIT 1`));
    const url = `https://api.neodove.com/integration/custom/e2e-test-${Date.now()}/leads`;
    try {
        const { last4 } = await saveCampaignEndpoint({ campaignId: c.id, kind: "push", url, actorId: "00000000-0000-0000-0000-000000000000" });
        const [row] = rowsOf<{ ciphertext: string; last4: string }>(
            await db.execute(sql`SELECT ciphertext, last4 FROM neodove_campaign_endpoints WHERE campaign_id = ${c.id} AND kind = 'push'`),
        );
        check("the stored row holds no readable URL", !row.ciphertext.includes("neodove") && !row.ciphertext.includes("e2e-test"));
        const [ref] = rowsOf<{ r: string }>(await db.execute(sql`SELECT push_endpoint_ref AS r FROM neodove_campaigns WHERE id = ${c.id}`));
        check(`campaign now points at "${DB_ENDPOINT_REF}"`, ref.r === DB_ENDPOINT_REF);
        check("the push resolver returns the URL", (await resolveCampaignEndpoint(DB_ENDPOINT_REF, c.id)) === url);
        check("the campaign reads as wired", await isCampaignWired(DB_ENDPOINT_REF, c.id));
        const info = await storedEndpointInfo(c.id);
        check(`the screen sees only the last 4 (…${info.push?.last4})`, info.push?.last4 === last4 && !JSON.stringify(info).includes("e2e-test"));
        if (other) {
            await db.execute(sql`
                INSERT INTO neodove_campaign_endpoints (campaign_id, kind, ciphertext, iv, tag, last4)
                SELECT ${other.id}, 'update', ciphertext, iv, tag, last4 FROM neodove_campaign_endpoints
                 WHERE campaign_id = ${c.id} AND kind = 'push'
                ON CONFLICT DO NOTHING`);
            let opened = true;
            try {
                await resolveCampaignEndpoint(DB_ENDPOINT_REF, other.id, "update");
            } catch {
                opened = false;
            }
            check("a ciphertext copied onto another campaign does not open", !opened);
            await db.execute(sql`DELETE FROM neodove_campaign_endpoints WHERE campaign_id = ${other.id} AND kind = 'update'`);
        }
    } finally {
        await db.execute(sql`DELETE FROM neodove_campaign_endpoints WHERE campaign_id = ${c.id} AND kind = 'push'`);
        await db.execute(sql`UPDATE neodove_campaigns SET push_endpoint_ref = ${c.push_endpoint_ref} WHERE id = ${c.id}`);
    }
    const [back] = rowsOf<{ r: string | null }>(await db.execute(sql`SELECT push_endpoint_ref AS r FROM neodove_campaigns WHERE id = ${c.id}`));
    check("campaign restored to its old ref", back.r === c.push_endpoint_ref);

    console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
