// One-off: fill dealer_lead_phone_type (E-361) for every dealer lead, so the
// /leads "Needs dealer mobile" filter covers leads never put in a campaign.
//
//   node --import tsx --env-file=.env.local scripts/_backfill-e361-phone-types.ts [--dry-run]
//
// Runs against whatever DATABASE_URL points at (printed first). Idempotent:
// rows are upserted, so a re-run just refreshes them.
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { classifyPhone, type PhoneType } from "../src/lib/ai-dialer/numberHygiene";
import { hasPhoneTypeTable, recordPhoneTypes } from "../src/lib/ai-dialer/phoneTypeStore";

const dryRun = process.argv.includes("--dry-run");

async function main() {
    console.log("target:", new URL(process.env.DATABASE_URL!).host.split(".")[0], dryRun ? "(dry run)" : "");
    if (!dryRun && !(await hasPhoneTypeTable())) throw new Error("E-361 is not applied here");

    const rows = (await db.execute(sql`
        SELECT id, phone FROM dealer_leads WHERE coalesce(btrim(phone), '') <> ''
    `)) as unknown as { id: string; phone: string }[];

    const counts: Partial<Record<PhoneType, number>> = {};
    const typed = rows.map((r) => {
        const phoneType = classifyPhone(r.phone);
        counts[phoneType] = (counts[phoneType] ?? 0) + 1;
        // Exactly as stored: the /leads filter matches pt.phone = dl.phone.
        return { leadId: r.id, phone: r.phone, phoneType };
    });
    console.log(`${rows.length} leads with a phone`, counts);

    if (dryRun) return;
    const written = await recordPhoneTypes(typed);
    console.log(`upserted ${written} rows`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
