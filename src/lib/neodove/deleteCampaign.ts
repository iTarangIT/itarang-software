/**
 * Hard-delete one NeoDove campaign (26 Oct, Admin / Sales Head).
 *
 *   * neodove_lead_links rows CASCADE away — this campaign's push history;
 *   * neodove_sync_events keep their rows with neodove_campaign_id SET NULL,
 *     so the raw inbound ledger still serves reconcile and replay;
 *   * neodove_campaign_endpoints has no FK, so its sealed URL is deleted here
 *     explicitly — otherwise the credential would outlive its campaign.
 *
 * Leads, their owners, neodove_sync_status and call touchpoints are untouched.
 * Nothing is sent to NeoDove; the campaign there has to be deleted there.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { hasEndpointStore } from "./endpointStore";

export type DeleteCampaignResult =
    | { ok: true; name: string; removedLinks: number }
    | { ok: false; status: 404 | 409; message: string };

export async function deleteNeodoveCampaign(id: string): Promise<DeleteCampaignResult> {
    const [c] = (await db.execute(sql`
        SELECT c.name, c.status,
               (SELECT COUNT(*) FROM neodove_lead_links l WHERE l.neodove_campaign_id = c.id)::int AS links
          FROM neodove_campaigns c
         WHERE c.id = ${id} LIMIT 1
    `)) as unknown as { name: string; status: string; links: number }[];
    if (!c) return { ok: false, status: 404, message: "Campaign not found" };
    // A drain in flight writes link rows for this id; deleting under it would
    // fail those inserts half-way through the batch.
    if (c.status === "pushing") {
        return { ok: false, status: 409, message: "This campaign is sending leads right now. Wait for it to finish, then delete." };
    }

    const store = await hasEndpointStore();
    await db.transaction(async (tx) => {
        if (store) {
            await tx.execute(sql`DELETE FROM neodove_campaign_endpoints WHERE campaign_id = ${id}`);
        }
        await tx.execute(sql`DELETE FROM neodove_campaigns WHERE id = ${id}`);
    });
    return { ok: true, name: c.name, removedLinks: Number(c.links) };
}
