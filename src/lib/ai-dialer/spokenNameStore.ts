/**
 * E-378 — a rep's override of the shop name the AI dialer says. Raw SQL, not
 * in schema.ts, behind a to_regclass probe: without the table every call gets
 * the computed name (spokenName.ts) and saving an override is refused.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { resolveSpokenName, spokenShopName } from "./spokenName";

export const SPOKEN_NAME_MAX = 80;

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

let probe: { at: number; ok: boolean } | null = null;
export async function hasSpokenNameTable(): Promise<boolean> {
    if (probe && Date.now() - probe.at < 5 * 60_000) return probe.ok;
    try {
        const r = await db.execute(sql`SELECT to_regclass('public.dealer_lead_spoken_names') IS NOT NULL AS ok`);
        probe = { at: Date.now(), ok: !!rowsOf<{ ok: boolean }>(r)[0]?.ok };
    } catch {
        probe = { at: Date.now(), ok: false };
    }
    return probe.ok;
}

/** The rep's override for a lead, or null. Never throws. */
export async function spokenNameOverride(leadId: string): Promise<string | null> {
    if (!leadId || !(await hasSpokenNameTable())) return null;
    try {
        const r = await db.execute(
            sql`SELECT spoken_name FROM dealer_lead_spoken_names WHERE lead_id = ${leadId} LIMIT 1`,
        );
        return rowsOf<{ spoken_name: string }>(r)[0]?.spoken_name ?? null;
    } catch (err) {
        console.warn("[spoken-name] override read failed:", err);
        return null;
    }
}

/** What the agent says for this lead: the override, else the computed name. */
export async function spokenNameFor(lead: { id: string; shop_name: string | null }): Promise<string> {
    return resolveSpokenName(lead.shop_name, await spokenNameOverride(lead.id));
}

export type SpokenNameView = { computed: string; override: string | null; spoken: string; editable: boolean };

export async function spokenNameView(lead: { id: string; shop_name: string | null }): Promise<SpokenNameView> {
    const editable = await hasSpokenNameTable();
    const override = editable ? await spokenNameOverride(lead.id) : null;
    const computed = spokenShopName(lead.shop_name);
    return { computed, override, spoken: resolveSpokenName(lead.shop_name, override), editable };
}

/** Set (or, with a blank name, clear) the override. False when E-378 is missing. */
export async function setSpokenNameOverride(leadId: string, name: string | null, userId: string | null): Promise<boolean> {
    if (!(await hasSpokenNameTable())) return false;
    const clean = (name ?? "").replace(/\s+/g, " ").trim().slice(0, SPOKEN_NAME_MAX);
    if (!clean) {
        await db.execute(sql`DELETE FROM dealer_lead_spoken_names WHERE lead_id = ${leadId}`);
        return true;
    }
    await db.execute(sql`
        INSERT INTO dealer_lead_spoken_names (lead_id, spoken_name, set_by, set_at)
        VALUES (${leadId}, ${clean}, ${userId}, now())
        ON CONFLICT (lead_id) DO UPDATE
           SET spoken_name = EXCLUDED.spoken_name, set_by = EXCLUDED.set_by, set_at = now()`);
    return true;
}
