/**
 * A32 — NeoDove campaign endpoints kept in the database, encrypted (E-351),
 * so Admin can wire a new campaign from the screen instead of asking a
 * developer to add an env var. The URL is the credential: it is sealed
 * (secretBox.ts), bound to its campaign and kind, decrypted only at push time,
 * and never returned to a browser — the screen sees only the last 4 characters.
 *
 * A campaign uses its stored endpoint when push_endpoint_ref = DB_ENDPOINT_REF;
 * any other ref is still an env var NAME (config.ts), so existing campaigns
 * work unchanged.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { lastChars, open, seal, secretBoxEnabled } from "@/lib/security/secretBox";
import { NeodoveEndpointMissingError, resolveEndpoint } from "./config";

/** push_endpoint_ref / update_endpoint_ref value meaning "stored in E-351". */
export const DB_ENDPOINT_REF = "DB";

export type EndpointKind = "push" | "update";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];
const aad = (campaignId: string, kind: EndpointKind) => `neodove:${campaignId}:${kind}`;

/** Is E-351 on this database? */
export async function hasEndpointStore(): Promise<boolean> {
    try {
        const r = rowsOf<{ ok: boolean }>(await db.execute(sql`SELECT to_regclass('public.neodove_campaign_endpoints') IS NOT NULL AS ok`));
        return Boolean(r[0]?.ok);
    } catch {
        return false;
    }
}

/** Can Admin store endpoints here? The table and an encryption key are both needed. */
export async function endpointStoreStatus(): Promise<{ ready: boolean; reason: string | null }> {
    if (!(await hasEndpointStore())) return { ready: false, reason: "Migration E-351 is not on this database yet." };
    if (!secretBoxEnabled()) return { ready: false, reason: "No encryption key on this server (APP_SECRETS_ENC_KEY)." };
    return { ready: true, reason: null };
}

/** A NeoDove Custom Integration URL: https, a host, a path with a token in it. */
export function validEndpointUrl(raw: string): string | null {
    try {
        const u = new URL(raw.trim());
        if (u.protocol !== "https:") return "The endpoint must start with https://";
        if (!u.hostname.includes(".")) return "That is not a full web address.";
        if (u.pathname.length < 8) return "That address has no campaign token in it — copy the whole Custom Integration URL.";
        return null;
    } catch {
        return "That is not a web address — copy the whole Custom Integration URL from NeoDove.";
    }
}

/** Store (or replace) a campaign's endpoint and point the campaign at it. Returns the last 4 characters. */
export async function saveCampaignEndpoint(input: {
    campaignId: string;
    kind: EndpointKind;
    url: string;
    actorId: string;
}): Promise<{ last4: string }> {
    const sealed = seal(input.url.trim(), aad(input.campaignId, input.kind));
    const last4 = lastChars(input.url.trim());
    const col = input.kind === "push" ? sql`push_endpoint_ref` : sql`update_endpoint_ref`;
    await db.transaction(async (tx) => {
        await tx.execute(sql`
            INSERT INTO neodove_campaign_endpoints (campaign_id, kind, ciphertext, iv, tag, last4, updated_by, updated_at)
            VALUES (${input.campaignId}, ${input.kind}, ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag}, ${last4}, ${input.actorId}, now())
            ON CONFLICT (campaign_id, kind) DO UPDATE
               SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
                   last4 = EXCLUDED.last4, updated_by = EXCLUDED.updated_by, updated_at = now()`);
        await tx.execute(sql`UPDATE neodove_campaigns SET ${col} = ${DB_ENDPOINT_REF}, updated_at = now() WHERE id = ${input.campaignId}`);
    });
    return { last4 };
}

/** What the screen may know about stored endpoints: kind → last 4 and when. Never the URL. */
export async function storedEndpointInfo(campaignId: string): Promise<Partial<Record<EndpointKind, { last4: string; updated_at: string }>>> {
    if (!(await hasEndpointStore())) return {};
    const rows = rowsOf<{ kind: EndpointKind; last4: string; updated_at: string }>(
        await db.execute(sql`
            SELECT kind, last4, updated_at::text AS updated_at FROM neodove_campaign_endpoints WHERE campaign_id = ${campaignId}`),
    );
    return Object.fromEntries(rows.map((r) => [r.kind, { last4: r.last4, updated_at: r.updated_at }]));
}

/** The campaign ids with a stored endpoint of this kind that opens with this server's key. */
export async function campaignsWithStoredEndpoint(kind: EndpointKind = "push"): Promise<Set<string>> {
    const out = new Set<string>();
    if (!(await hasEndpointStore()) || !secretBoxEnabled()) return out;
    const rows = rowsOf<{ campaign_id: string; ciphertext: string; iv: string; tag: string }>(
        await db.execute(sql`SELECT campaign_id, ciphertext, iv, tag FROM neodove_campaign_endpoints WHERE kind = ${kind}`),
    );
    for (const r of rows) if (open(r, aad(r.campaign_id, kind)) != null) out.add(r.campaign_id);
    return out;
}

/**
 * The URL to push to, for a campaign's ref: the stored endpoint when the ref
 * is DB_ENDPOINT_REF, else the env var it names. Throws
 * NeodoveEndpointMissingError, like resolveEndpoint().
 */
export async function resolveCampaignEndpoint(ref: string | null | undefined, campaignId: string | null, kind: EndpointKind = "push"): Promise<string> {
    if (ref !== DB_ENDPOINT_REF) return resolveEndpoint(ref);
    if (!campaignId) throw new NeodoveEndpointMissingError("(stored endpoint, no campaign)");
    const [r] = rowsOf<{ ciphertext: string; iv: string; tag: string }>(
        await db.execute(sql`
            SELECT ciphertext, iv, tag FROM neodove_campaign_endpoints WHERE campaign_id = ${campaignId} AND kind = ${kind}`),
    );
    const url = r ? open(r, aad(campaignId, kind)) : null;
    if (!url) throw new NeodoveEndpointMissingError(`stored ${kind} endpoint for ${campaignId}`);
    return url;
}

/** Is this campaign's ref usable on this server (env var set, or stored endpoint that opens)? */
export async function isCampaignWired(ref: string | null | undefined, campaignId: string, kind: EndpointKind = "push"): Promise<boolean> {
    try {
        await resolveCampaignEndpoint(ref, campaignId, kind);
        return true;
    } catch {
        return false;
    }
}
