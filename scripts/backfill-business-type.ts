/**
 * Backfill dealer_leads.business_type for leads created before E-296
 * (tracker ID 11, 29 Sep 2026; buyback rule fixed 01 Oct 2026).
 *
 *   node --import tsx --env-file=.env.local scripts/backfill-business-type.ts          # dry run
 *   node --import tsx --env-file=.env.local scripts/backfill-business-type.ts --apply  # write
 *
 * Every lead created before 17 Sep is NULL ("Not set"), so filtering by type
 * hides the back catalogue. Tags ONLY where there is evidence, most specific
 * first; everything else stays NULL:
 *   1. the scraped listing this lead came from (scraped_dealer_leads.business_type,
 *      then products_sold), through normalizeBusinessType;
 *   2. a buyback request raised by the lead's dealer → buyback. A request has
 *      no GSTIN or phone of its own: it belongs to a dealer ACCOUNT
 *      (dealer_entity_id), and the account carries both. Matched on the
 *      account's GSTIN (the lead's own, or its onboarding application's — the
 *      R-11 rule, GSTIN_KEY), else on the account's contact phone (last ten
 *      digits);
 *   3. a finance application from this dealer → finance.
 * Never overwrites a value a person set. Re-run = no-op.
 *
 * AUDIT. The E-304 trigger logs every business_type change to
 * dealer_lead_field_changes; the writes run with app.actor_id set to ACTOR
 * below, so those rows say this script made them instead of "not recorded".
 */
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { normalizeBusinessType } from "../src/lib/leads/businessType";
import { GSTIN_KEY } from "../src/lib/leads/gstinMatch";
import { withLeadActor } from "../src/lib/leads/actorContext";

const ACTOR = "system:backfill-business-type";

type Row = {
    id: string;
    scraped_type: string | null;
    products_sold: string | null;
    buyback_gstin: boolean;
    buyback_phone: boolean;
    finance: boolean;
};

const last10 = (expr: ReturnType<typeof sql>) => sql`right(regexp_replace(COALESCE(${expr}, ''), '\\D', '', 'g'), 10)`;

async function main() {
    const apply = process.argv.includes("--apply");
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);

    const rows = (await db.execute<Row>(sql`
        SELECT dl.id,
               s.business_type AS scraped_type,
               s.products_sold,
               EXISTS (SELECT 1 FROM buyback_requests br
                         JOIN accounts a ON a.id = br.dealer_entity_id
                        WHERE ${GSTIN_KEY(sql`a.gstin`)} IS NOT NULL
                          AND ${GSTIN_KEY(sql`a.gstin`)} IN (${GSTIN_KEY(sql`dl.gstin`)}, ${GSTIN_KEY(sql`oa.gst_number`)})
                      ) AS buyback_gstin,
               EXISTS (SELECT 1 FROM buyback_requests br
                         JOIN accounts a ON a.id = br.dealer_entity_id
                        WHERE length(${last10(sql`dl.phone`)}) = 10
                          AND ${last10(sql`a.contact_phone`)} = ${last10(sql`dl.phone`)}
                      ) AS buyback_phone,
               COALESCE(oa.finance_enabled, FALSE) AS finance
          FROM dealer_leads dl
          LEFT JOIN dealer_onboarding_applications oa ON oa.id = dl.dealer_onboarding_application_id
          LEFT JOIN LATERAL (
              SELECT sd.business_type, sd.products_sold FROM scraped_dealer_leads sd
               WHERE sd.converted_lead_id = dl.id
               ORDER BY sd.id LIMIT 1
          ) s ON TRUE
         WHERE dl.business_type IS NULL
    `)) as unknown as Row[];

    const plan: Array<{ id: string; type: string; why: string }> = [];
    for (const r of rows) {
        const fromScrape = normalizeBusinessType(r.scraped_type) ?? normalizeBusinessType(r.products_sold);
        if (fromScrape) plan.push({ id: r.id, type: fromScrape, why: "scraped listing" });
        else if (r.buyback_gstin) plan.push({ id: r.id, type: "buyback", why: "buyback request by its dealer account (GSTIN)" });
        else if (r.buyback_phone) plan.push({ id: r.id, type: "buyback", why: "buyback request by its dealer account (phone)" });
        else if (r.finance) plan.push({ id: r.id, type: "finance", why: "finance-enabled onboarding" });
    }
    const byType = new Map<string, number>();
    for (const p of plan) byType.set(`${p.type} (${p.why})`, (byType.get(`${p.type} (${p.why})`) ?? 0) + 1);
    console.log(`${rows.length} leads with no business type; ${plan.length} have evidence, ${rows.length - plan.length} stay "Not set".`);
    for (const [k, n] of byType) console.log(`  ${k}: ${n}`);

    if (!apply) {
        console.log("Dry run. Re-run with --apply to write.");
        process.exit(0);
    }
    let updated = 0;
    await withLeadActor(ACTOR, async (tx) => {
        for (const p of plan) {
            const r = (await tx.execute(sql`
                UPDATE dealer_leads SET business_type = ${p.type}
                 WHERE id = ${p.id} AND business_type IS NULL
                RETURNING id
            `)) as unknown as unknown[];
            updated += r.length;
        }
    });
    console.log(`Updated ${updated} (audit rows: changed_by = '${ACTOR}').`);
    process.exit(0);
}

void main();
