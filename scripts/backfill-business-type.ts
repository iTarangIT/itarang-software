/**
 * Backfill dealer_leads.business_type for leads created before E-296
 * (tracker ID 11, 29 Sep 2026).
 *
 *   node --import tsx --env-file=.env.local scripts/backfill-business-type.ts          # dry run
 *   node --import tsx --env-file=.env.local scripts/backfill-business-type.ts --apply  # write
 *
 * Every lead created before 17 Sep is NULL ("Not set"), so filtering by type
 * hides the back catalogue. Tags ONLY where there is evidence, most specific
 * first; everything else stays NULL:
 *   1. the scraped listing this lead came from (scraped_dealer_leads.business_type,
 *      then products_sold), through normalizeBusinessType;
 *   2. a buyback request raised for the lead's GSTIN / phone → buyback;
 *   3. a finance application from this dealer → finance.
 * Never overwrites a value a person set. Re-run = no-op.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { normalizeBusinessType } from "../src/lib/leads/businessType";

type Row = { id: string; scraped_type: string | null; products_sold: string | null; buyback: boolean; finance: boolean };

async function main() {
    const apply = process.argv.includes("--apply");
    const rows = (await db.execute<Row>(sql`
        SELECT dl.id,
               s.business_type AS scraped_type,
               s.products_sold,
               EXISTS (SELECT 1 FROM buyback_requests br
                        WHERE (dl.gstin IS NOT NULL AND to_jsonb(br) ->> 'gstin' = dl.gstin)) AS buyback,
               EXISTS (SELECT 1 FROM dealer_onboarding_applications oa
                        WHERE oa.id = dl.dealer_onboarding_application_id AND oa.finance_enabled = TRUE) AS finance
          FROM dealer_leads dl
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
        else if (r.buyback) plan.push({ id: r.id, type: "buyback", why: "buyback request on its GSTIN" });
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
    for (const p of plan) {
        await db.execute(sql`UPDATE dealer_leads SET business_type = ${p.type} WHERE id = ${p.id} AND business_type IS NULL`);
    }
    console.log(`Updated ${plan.length}.`);
    process.exit(0);
}

void main();
