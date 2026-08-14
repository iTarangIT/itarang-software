// "Which campaign is this lead in?" — for the admin Leads list.
//
// THERE ARE TWO CAMPAIGN SYSTEMS AND THE COLUMN HAS TO COVER BOTH. `dialer_
// campaigns` (E-109, the AI dialer) and `neodove_campaigns` (E-224, the external
// calling team) are unrelated tables with no shared parent. Measured on
// database-1: 1,501 leads sit in a dialer campaign and 18 in a NeoDove one, so a
// column built on either table alone reads "—" for almost every lead that
// demonstrably belongs to a campaign. Zero leads are currently in both, but that
// is a fact about today's data and not a constraint, so the merge below picks
// the most recent rather than assuming it can never happen.
//
// ⚠ DECORATION, NOT A JOIN. This runs as its own statements against the ids on
// the current page, exactly like the neodove_sync_status read in
// /api/dealer-leads. Folding it into fetchLeadListRows would put neodove_* in
// the main query, and those tables do not exist on prod (database-2) — a missing
// RELATION fails at parse time just as a missing column does, which would take
// the entire Leads list down there rather than costing one column.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { CampaignSystem } from "@/lib/leads/campaign";

export type LeadCampaign = {
    /** The campaign's own name. */
    name: string;
    /** Which system it belongs to — the two are not interchangeable. */
    system: CampaignSystem;
    /** When the LEAD entered this campaign. */
    joined_at: string | null;
    /** When the CAMPAIGN itself was created. */
    campaign_created_at: string | null;
};

type Row = {
    id: string;
    name: string | null;
    joined_at: string | null;
    campaign_created_at: string | null;
};

/**
 * Latest campaign per lead, keyed by lead id. Never throws.
 *
 * The two halves are separate statements with separate try/catch on purpose: a
 * database with E-109 but not E-224 must keep its dialer campaign names, not
 * lose the whole column to the half it does not have.
 */
export async function fetchCampaignForLeads(
    leadIds: string[],
): Promise<Record<string, LeadCampaign>> {
    const out: Record<string, LeadCampaign> = {};
    if (!leadIds.length) return out;

    // ⚠ IN (…), NOT `= ANY(${leadIds})`. Drizzle expands a JS array into
    // `($1, $2, $3)` — a ROW CONSTRUCTOR, not an array literal — so `= ANY(…)`
    // is a syntax error against postgres.js. It does not throw a type error, it
    // throws at the database, which the try/catch below would have swallowed
    // into a permanently empty column. Caught only by running it.
    const idList = sql.join(
        leadIds.map((id) => sql`${id}`),
        sql`, `,
    );

    const consider = (row: Row, system: LeadCampaign["system"]) => {
        if (!row.name) return;
        const existing = out[row.id];
        // Most recently joined wins. A lead in both systems shows where it went
        // last, which is the one that explains what is happening to it now.
        if (
            existing &&
            new Date(existing.joined_at ?? 0).getTime() >=
                new Date(row.joined_at ?? 0).getTime()
        ) {
            return;
        }
        out[row.id] = {
            name: row.name,
            system,
            joined_at: row.joined_at,
            campaign_created_at: row.campaign_created_at,
        };
    };

    // ── AI dialer (E-109) ────────────────────────────────────────────────
    try {
        const rows = await db.execute<Row>(sql`
            SELECT DISTINCT ON (dcl.lead_id)
                   dcl.lead_id    AS id,
                   dc.name        AS name,
                   dcl.created_at AS joined_at,
                   dc.created_at  AS campaign_created_at
              FROM dialer_campaign_leads dcl
              JOIN dialer_campaigns dc ON dc.id = dcl.campaign_id
             WHERE dcl.lead_id IN (${idList})
             ORDER BY dcl.lead_id, dcl.created_at DESC
        `);
        for (const r of rows as unknown as Row[]) consider(r, "ai_dialer");
    } catch {
        // No dialer tables here — leave the dialer half empty.
    }

    // ── NeoDove (E-224) ──────────────────────────────────────────────────
    //
    // TWO SOURCES, UNIONED. `neodove_lead_links` only has a row for leads WE
    // pushed. Leads NeoDove created (`neodove_sync_status = 'inbound'`) arrive
    // through the webhook, and it does not name a campaign — measured on
    // database-1, 581 inbound leads exist and only 4 are resolvable to one at
    // all, via the campaign id on their ledger row. So the ledger is folded in:
    // it is the only place those 4 are knowable, and the remaining 577 correctly
    // read "No campaign" because NeoDove never told us which one they are in.
    try {
        const rows = await db.execute<Row>(sql`
            SELECT DISTINCT ON (x.id)
                   x.id           AS id,
                   nc.name        AS name,
                   x.joined_at    AS joined_at,
                   nc.created_at  AS campaign_created_at
              FROM (
                    SELECT nll.dealer_lead_id                      AS id,
                           nll.neodove_campaign_id                 AS cid,
                           COALESCE(nll.pushed_at, nll.created_at) AS joined_at
                      FROM neodove_lead_links nll
                     WHERE nll.dealer_lead_id IN (${idList})
                       -- A link row also exists for leads the push REFUSED or
                       -- skipped as a duplicate. Those leads never reached the
                       -- campaign, and naming it on their row would assert a
                       -- hand-off that did not happen.
                       AND nll.push_status IN ('pushed', 'pending')
                    UNION ALL
                    SELECT nse.dealer_lead_id,
                           nse.neodove_campaign_id,
                           nse.created_at
                      FROM neodove_sync_events nse
                     WHERE nse.dealer_lead_id IN (${idList})
                       AND nse.neodove_campaign_id IS NOT NULL
                       -- ⚠ INBOUND ONLY, and this is load-bearing. An OUTBOUND
                       -- push_lead event is written with its campaign id even
                       -- when the push FAILED, so without this the ledger hands
                       -- back exactly the leads push_status excludes above and
                       -- a refused push claims a campaign it never reached.
                       -- Outbound is already fully covered by the links half.
                       AND nse.direction = 'inbound'
                   ) x
              JOIN neodove_campaigns nc ON nc.id = x.cid
             ORDER BY x.id, x.joined_at DESC
        `);
        for (const r of rows as unknown as Row[]) consider(r, "neodove");
    } catch {
        // E-224 not applied here — leave the NeoDove half empty.
    }

    return out;
}

// ── Filter support ───────────────────────────────────────────────────────

/**
 * Are the NeoDove tables present on this database?
 *
 * The campaign FILTER cannot use the to_jsonb trick that the sync-status filter
 * does: that works around a missing COLUMN, and a missing RELATION fails at
 * parse time no matter what guard is wrapped around it — `to_regclass(…) IS NOT
 * NULL AND EXISTS (SELECT … FROM neodove_lead_links …)` still fails to parse.
 * So the branch has to be omitted from the SQL entirely, which means knowing the
 * answer BEFORE the statement is built.
 *
 * Cached for the life of the process. A database that gains E-224 needs a
 * restart before the NeoDove half of this filter starts working — acceptable
 * because applying a migration here is a deploy-time act, and the alternative is
 * an extra round trip on every filtered request forever.
 */
let neodovePresent: Promise<boolean> | null = null;

export function neodoveTablesPresent(): Promise<boolean> {
    if (!neodovePresent) {
        neodovePresent = db
            .execute<{ present: boolean }>(
                sql`SELECT to_regclass('public.neodove_lead_links') IS NOT NULL AS present`,
            )
            .then((rows) => Boolean((rows as unknown as { present: boolean }[])[0]?.present))
            .catch(() => false);
    }
    return neodovePresent;
}

export type CampaignFacet = {
    id: string;
    /** Stored name. AUTHORITATIVE for NeoDove; stale for AI dialer — see below. */
    name: string;
    system: CampaignSystem;
    /**
     * How many leads selecting this campaign will return. NOT always the number
     * the Campaigns tab shows: that one counts every neodove_lead_links row,
     * while the filter (and the Campaign column) only count links that actually
     * reached the campaign. The dropdown shows the count the filter will honour,
     * because that is the promise the number makes.
     */
    lead_count: number;
    // ── AI-dialer label inputs ───────────────────────────────────────────
    // Returned raw, and formatted by the CLIENT with displayCampaignName —
    // the same call the Campaigns tab makes. See fetchCampaignFacets.
    category: string | null;
    region_filter: unknown;
    started_at: string | null;
};

/**
 * Every campaign in either system, for the filter dropdown.
 *
 * ⚠ THIS LIST MUST MATCH THE CAMPAIGNS TAB. That tab (GET /api/campaigns/
 * unified) UNIONs dialer_campaigns and neodove_campaigns with NO status filter
 * and NO zero-lead exclusion, so a campaign visible there and absent here reads
 * as a missing filter. Two earlier divergences, both fixed:
 *
 *   1. Empty campaigns were excluded via an INNER JOIN. The reasoning — that
 *      offering one guarantees a zero-row result — is real but loses to the
 *      tab: a NeoDove campaign is created in `draft` with no links at all and
 *      shows up there immediately, so it must be selectable here too. The lead
 *      count is rendered beside each option, which telegraphs the empty result
 *      without hiding the campaign.
 *
 *   2. AI-dialer options used `dialer_campaigns.name`. The tab deliberately
 *      IGNORES that column (regionSummary.ts:91-94: rows predating the
 *      region-shape fix carry a frozen name like "All segments · All regions"
 *      while their region_filter holds the right data) and derives the title
 *      from category + region_filter + started_at instead. Using the stored
 *      name meant the same campaign was called two different things on two
 *      tabs — which is why it looked absent.
 *
 * The label is composed on the CLIENT rather than here, because
 * displayCampaignName renders the timestamp with toLocaleString and no explicit
 * timeZone: formatting it on a UTC server would shift every label 5.5 hours off
 * what the Campaigns tab shows in the browser.
 */
export async function fetchCampaignFacets(): Promise<CampaignFacet[]> {
    const out: CampaignFacet[] = [];

    try {
        const rows = await db.execute<{
            id: string;
            name: string;
            category: string | null;
            region_filter: unknown;
            started_at: string | null;
            c: string;
        }>(sql`
            SELECT dc.id,
                   dc.name,
                   dc.category,
                   dc.region_filter,
                   dc.started_at,
                   COUNT(dcl.lead_id)::text AS c
              FROM dialer_campaigns dc
              -- LEFT, so a campaign with no leads still appears (see above).
              LEFT JOIN dialer_campaign_leads dcl ON dcl.campaign_id = dc.id
             GROUP BY dc.id, dc.name, dc.category, dc.region_filter,
                      dc.started_at, dc.created_at
             -- Same sort key as the Campaigns tab's ORDER BY.
             ORDER BY COALESCE(dc.started_at, dc.created_at) DESC
        `);
        for (const r of rows as unknown as {
            id: string;
            name: string;
            category: string | null;
            region_filter: unknown;
            started_at: string | null;
            c: string;
        }[]) {
            out.push({
                id: r.id,
                name: r.name,
                system: "ai_dialer",
                lead_count: Number(r.c),
                category: r.category,
                region_filter: r.region_filter,
                started_at: r.started_at,
            });
        }
    } catch {
        // No dialer tables here.
    }

    try {
        const rows = await db.execute<{
            id: string;
            name: string;
            c: string;
        }>(sql`
            SELECT nc.id,
                   nc.name,
                   COUNT(nll.dealer_lead_id)::text AS c
              FROM neodove_campaigns nc
              -- LEFT + the push_status test moved into the JOIN: an INNER join
              -- would drop draft campaigns, and moving the test to WHERE would
              -- do the same by turning the LEFT join back into an inner one.
              LEFT JOIN neodove_lead_links nll
                ON nll.neodove_campaign_id = nc.id
               AND nll.push_status IN ('pushed', 'pending')
             GROUP BY nc.id, nc.name, nc.started_at, nc.created_at
             ORDER BY COALESCE(nc.started_at, nc.created_at) DESC
        `);
        for (const r of rows as unknown as {
            id: string;
            name: string;
            c: string;
        }[]) {
            out.push({
                id: r.id,
                name: r.name,
                system: "neodove",
                lead_count: Number(r.c),
                // NeoDove campaigns are named by a human at creation, so the
                // stored name is authoritative and needs no derivation.
                category: null,
                region_filter: null,
                started_at: null,
            });
        }
    } catch {
        // E-224 not applied here.
    }

    return out;
}
