// Acquisition campaigns (tracker ID 81, E-314 + E-319): the specific event,
// list or batch a lead came in on. Separate from dialler campaigns
// (dialer_campaigns / neodove_campaigns), which say who CALLS a lead, not where
// it came from.
//
// Two kinds of campaign:
//   - named by a person — a trade event, an ad, a bought list. Picked on the
//     create and upload forms; REQUIRED when Found via is Trade event or
//     Digital ad (campaignRequired).
//   - made by the system — one per bulk-upload batch, scrape run and AI-dialer
//     list, so every lead that arrives in bulk can be traced to its batch.
//
// The table and its columns are not in schema.ts (see E-314 / E-319), so
// everything here is raw SQL. The system-made campaigns are best-effort: a
// database without E-319 loses the campaign link and nothing else.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    CAMPAIGN_REQUIRED_MESSAGE,
    campaignRequired,
    listCampaignName,
    scrapeCampaignName,
    uploadCampaignName,
    type CampaignKind,
    type LeadOrigin,
} from "./leadSourceVocab";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Tx | typeof db;

export type AcquisitionCampaign = {
    id: string;
    name: string;
    origin: string | null;
    kind: CampaignKind;
    is_active: boolean;
    starts_on: string | null;
    ends_on: string | null;
    notes: string | null;
    created_by: string | null;
    created_by_name: string | null;
    created_at: string;
    lead_count: number;
};

/** A refused campaign choice — carries the HTTP status for withErrorHandler. */
export class CampaignError extends Error {
    readonly status: number;
    constructor(message: string, status = 400) {
        super(message);
        this.name = "CampaignError";
        this.status = status;
    }
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export async function listCampaigns(opts?: {
    /** Campaigns of this origin, plus those with no origin set. */
    origin?: string | null;
    /** Pickers pass true; the admin screen lists everything. */
    activeOnly?: boolean;
    /** Pickers pass true: only campaigns a person named. */
    manualOnly?: boolean;
}): Promise<AcquisitionCampaign[]> {
    const rows = await db.execute<AcquisitionCampaign>(sql`
        SELECT c.id::text AS id, c.name, c.origin, c.kind, c.is_active,
               c.starts_on::text AS starts_on, c.ends_on::text AS ends_on,
               c.notes, c.created_by, u.name AS created_by_name,
               c.created_at::text AS created_at,
               (SELECT count(*)::int FROM dealer_leads dl
                 WHERE dl.acquisition_campaign_id = c.id) AS lead_count
          FROM acquisition_campaigns c
          LEFT JOIN users u ON u.id::text = c.created_by
         WHERE TRUE
           ${opts?.activeOnly ? sql`AND c.is_active` : sql``}
           ${opts?.manualOnly ? sql`AND c.kind = 'manual'` : sql``}
           ${opts?.origin ? sql`AND (c.origin = ${opts.origin} OR c.origin IS NULL)` : sql``}
         ORDER BY c.is_active DESC, c.created_at DESC
         LIMIT 500
    `);
    return rows as unknown as AcquisitionCampaign[];
}

export type CampaignInput = {
    name: string;
    origin?: LeadOrigin | null;
    kind?: CampaignKind;
    startsOn?: string | null;
    endsOn?: string | null;
    notes?: string | null;
    createdBy?: string | null;
};

/** Create a campaign a person named. A name already in use is refused. */
export async function createCampaign(input: CampaignInput): Promise<{ id: string; name: string }> {
    const name = input.name.trim().replace(/\s+/g, " ");
    if (name.length < 2) throw new CampaignError("Give the campaign a name.");
    const rows = await db.execute<{ id: string }>(sql`
        INSERT INTO acquisition_campaigns (name, origin, kind, starts_on, ends_on, notes, created_by)
        VALUES (${name}, ${input.origin ?? null}, ${input.kind ?? "manual"},
                ${input.startsOn ?? null}::date, ${input.endsOn ?? null}::date,
                ${input.notes?.trim() || null}, ${input.createdBy ?? null})
        ON CONFLICT (lower(name)) DO NOTHING
        RETURNING id::text AS id
    `);
    const id = (rows as unknown as { id: string }[])[0]?.id;
    if (!id) throw new CampaignError(`A campaign named "${name}" already exists — pick it from the list.`, 409);
    return { id, name };
}

/** The campaign with this name, created if it is not there yet. */
export async function getOrCreateCampaign(exec: Exec, input: CampaignInput): Promise<string> {
    const name = input.name.trim().replace(/\s+/g, " ");
    await exec.execute(sql`
        INSERT INTO acquisition_campaigns (name, origin, kind, starts_on, notes, created_by)
        VALUES (${name}, ${input.origin ?? null}, ${input.kind ?? "manual"},
                COALESCE(${input.startsOn ?? null}::date, CURRENT_DATE),
                ${input.notes?.trim() || null}, ${input.createdBy ?? null})
        ON CONFLICT (lower(name)) DO NOTHING
    `);
    const rows = await exec.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM acquisition_campaigns WHERE lower(name) = lower(${name}) LIMIT 1
    `);
    const id = (rows as unknown as { id: string }[])[0]?.id;
    if (!id) throw new CampaignError("The campaign could not be saved.", 500);
    return id;
}

export async function updateCampaign(
    id: string,
    patch: {
        name?: string;
        origin?: LeadOrigin | null;
        startsOn?: string | null;
        endsOn?: string | null;
        notes?: string | null;
        isActive?: boolean;
    },
): Promise<void> {
    if (!isUuid(id)) throw new CampaignError("Campaign not found.", 404);
    const name = patch.name === undefined ? undefined : patch.name.trim().replace(/\s+/g, " ");
    if (name !== undefined && name.length < 2) throw new CampaignError("Give the campaign a name.");
    try {
        const rows = await db.execute<{ id: string }>(sql`
            UPDATE acquisition_campaigns SET
                name      = ${name === undefined ? sql`name` : sql`${name}`},
                origin    = ${patch.origin === undefined ? sql`origin` : sql`${patch.origin}`},
                starts_on = ${patch.startsOn === undefined ? sql`starts_on` : sql`${patch.startsOn}::date`},
                ends_on   = ${patch.endsOn === undefined ? sql`ends_on` : sql`${patch.endsOn}::date`},
                notes     = ${patch.notes === undefined ? sql`notes` : sql`${patch.notes?.trim() || null}`},
                is_active = ${patch.isActive === undefined ? sql`is_active` : sql`${patch.isActive}`},
                updated_at = NOW()
             WHERE id = ${id}::uuid
            RETURNING id::text AS id
        `);
        if ((rows as unknown as unknown[]).length === 0) throw new CampaignError("Campaign not found.", 404);
    } catch (e) {
        if ((e as { code?: string }).code === "23505") {
            throw new CampaignError(`A campaign named "${name}" already exists.`, 409);
        }
        throw e;
    }
}

/**
 * The campaign a new lead is to carry, checked: Trade event and Digital ad
 * leads must have one, and a campaign that is given must exist and be open.
 * Every creating path calls this BEFORE it inserts.
 */
export async function resolveLeadCampaign(
    exec: Exec,
    input: { origin: string | null | undefined; campaignId: string | null | undefined },
): Promise<string | null> {
    const campaignId = input.campaignId?.trim() || null;
    if (!campaignId) {
        if (campaignRequired(input.origin)) throw new CampaignError(CAMPAIGN_REQUIRED_MESSAGE);
        return null;
    }
    if (!isUuid(campaignId)) throw new CampaignError("That campaign does not exist.");
    const rows = await exec.execute<{ is_active: boolean }>(sql`
        SELECT is_active FROM acquisition_campaigns WHERE id = ${campaignId}::uuid LIMIT 1
    `);
    const row = (rows as unknown as { is_active: boolean }[])[0];
    if (!row) throw new CampaignError("That campaign does not exist.");
    if (!row.is_active) throw new CampaignError("That campaign is closed — pick an open one.");
    return campaignId;
}

/** A campaign by name, for the Assistant ("from the Auto Expo campaign"). */
export async function findCampaignByName(name: string): Promise<{ id: string; name: string } | null> {
    const rows = await db.execute<{ id: string; name: string }>(sql`
        SELECT id::text AS id, name FROM acquisition_campaigns
         WHERE is_active AND kind = 'manual' AND lower(name) = lower(${name.trim()}) LIMIT 1
    `);
    return (rows as unknown as { id: string; name: string }[])[0] ?? null;
}

export async function campaignName(id: string | null | undefined): Promise<string | null> {
    if (!id || !isUuid(id)) return null;
    try {
        const rows = await db.execute<{ name: string }>(sql`
            SELECT name FROM acquisition_campaigns WHERE id = ${id}::uuid LIMIT 1
        `);
        return (rows as unknown as { name: string }[])[0]?.name ?? null;
    } catch {
        return null;
    }
}

// ── The campaigns the system makes itself ───────────────────────────────────
// Each returns null instead of throwing: a batch must import and a run must
// promote whether or not its campaign could be recorded.

/** The campaign of one bulk-upload batch, linked on upload_batches. */
export async function campaignForUploadBatch(p: {
    batchId: string;
    fileName: string;
    label: string | null;
    origin: LeadOrigin;
    uploadedBy: string;
    /** A campaign the uploader picked — the batch is linked to it as it is. */
    pickedCampaignId?: string | null;
}): Promise<string | null> {
    try {
        const id =
            p.pickedCampaignId ??
            (await getOrCreateCampaign(db, {
                name: uploadCampaignName({ label: p.label, fileName: p.fileName, at: new Date(), batchId: p.batchId }),
                origin: p.origin,
                kind: "upload_batch",
                createdBy: p.uploadedBy,
                notes: `Bulk upload batch ${p.batchId}`,
            }));
        await db.execute(sql`
            UPDATE upload_batches SET acquisition_campaign_id = ${id}::uuid WHERE batch_id = ${p.batchId}::uuid
        `);
        return id;
    } catch (e) {
        console.warn("[campaigns] upload batch not linked (E-319 applied?):", e instanceof Error ? e.message : e);
        return null;
    }
}

/** The campaign of one scrape run, linked on scraper_runs; made on first use. */
export async function campaignForScrapeRun(runId: string): Promise<string | null> {
    try {
        const rows = await db.execute<{
            campaign_id: string | null;
            query: string | null;
            started_at: string;
            triggered_by: string | null;
        }>(sql`
            SELECT acquisition_campaign_id::text AS campaign_id,
                   CASE jsonb_typeof(search_queries)
                        WHEN 'string' THEN search_queries #>> '{}'
                        WHEN 'array'  THEN search_queries ->> 0
                        ELSE NULL END AS query,
                   started_at::text AS started_at, triggered_by::text AS triggered_by
              FROM scraper_runs WHERE id = ${runId} LIMIT 1
        `);
        const run = (rows as unknown as {
            campaign_id: string | null;
            query: string | null;
            started_at: string;
            triggered_by: string | null;
        }[])[0];
        if (!run) return null;
        if (run.campaign_id) return run.campaign_id;
        const id = await getOrCreateCampaign(db, {
            name: scrapeCampaignName({ query: run.query, at: new Date(run.started_at), runId }),
            origin: "scraped_listing",
            kind: "scrape_run",
            createdBy: run.triggered_by,
            notes: `Scrape run ${runId}`,
        });
        await db.execute(sql`
            UPDATE scraper_runs SET acquisition_campaign_id = ${id}::uuid WHERE id = ${runId}
        `);
        return id;
    } catch (e) {
        console.warn("[campaigns] scrape run not linked (E-319 applied?):", e instanceof Error ? e.message : e);
        return null;
    }
}

/** The campaign of one AI-dialer list — the same list name is the same campaign. */
export async function campaignForDialerList(p: {
    listName: string;
    origin: LeadOrigin;
    createdBy: string | null;
}): Promise<string | null> {
    if (!p.listName.trim()) return null;
    try {
        return await getOrCreateCampaign(db, {
            name: listCampaignName(p.listName),
            origin: p.origin,
            kind: "dialer_list",
            createdBy: p.createdBy,
        });
    } catch (e) {
        console.warn("[campaigns] dialer list campaign not made (E-319 applied?):", e instanceof Error ? e.message : e);
        return null;
    }
}
