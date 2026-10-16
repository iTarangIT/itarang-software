// Read-only check for tracker ID 186 (Kartik, 14 Oct): the deal card is asked
// only for a dealer who is not onboarded yet (no approved onboarding and no
// earlier battery invoice).
//
// Runs the REAL reader (src/lib/leads/dealerOnboarded.ts) — the one the quote
// form, the commercials POST and the lead page use — for every lead named like
// "Sharda" / "Sharada" (Anirudh #27, 13 Oct) and for the newest few quoted
// leads, and prints the verdict with its evidence. Writes nothing.
//
//   node --import tsx --env-file=.env.local scripts/verify-id186-onboarded.ts [leadId …]

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerIdentityForLead, isDealerOnboarded } from "@/lib/leads/dealerOnboarded";

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    console.log(`DB host: ${host}`);

    const ids = process.argv.slice(2);
    if (!ids.length) {
        const sharda = (await db.execute(sql`
            SELECT id FROM dealer_leads
             WHERE dealer_name ~* 'shar(a)?da' OR shop_name ~* 'shar(a)?da'
             ORDER BY created_at
        `)) as unknown as Array<{ id: string }>;
        const quoted = (await db.execute(sql`
            SELECT dealer_lead_id AS id FROM dealer_lead_commercials
             WHERE event_type IN ('quote_issue', 'quote_revision')
             GROUP BY dealer_lead_id ORDER BY MAX(created_at) DESC LIMIT 8
        `)) as unknown as Array<{ id: string }>;
        ids.push(...new Set([...sharda.map((r) => r.id), ...quoted.map((r) => r.id)]));
    }

    let onboarded = 0;
    for (const id of ids) {
        const started = Date.now();
        const [identity, verdict] = await Promise.all([dealerIdentityForLead(id), isDealerOnboarded(id)]);
        const ms = Date.now() - started;
        const name = (await db.execute(sql`SELECT dealer_name FROM dealer_leads WHERE id = ${id}`)) as unknown as Array<{
            dealer_name: string | null;
        }>;
        if (verdict.onboarded) onboarded++;
        console.log(`\n${id} · ${name[0]?.dealer_name ?? "?"} · ${ms} ms`);
        console.log(`  ${verdict.onboarded ? "ONBOARDED — no deal card, no fee line" : "NOT onboarded — deal card required"}`);
        console.log(`  ${verdict.reason}`);
        if (identity) {
            for (const a of identity.apps) {
                console.log(`  application ${a.id} · ${a.company_name ?? "?"} · ${a.onboarding_status} · via ${a.via}`);
            }
            for (const ac of identity.accounts) console.log(`  account ${ac.id} · ${ac.name ?? "?"}${ac.from_lead ? " · made from this lead" : ""}`);
            console.log(`  GSTINs: ${identity.gstinKeys.join(", ") || "none"}`);
        }
        if (verdict.batteryInvoice) {
            console.log(
                `  first battery invoice: ${verdict.batteryInvoice.invoiceNumber} on ${verdict.batteryInvoice.invoiceDate} (via ${verdict.batteryInvoice.via})`,
            );
        }
    }
    console.log(`\n${ids.length} lead(s): ${onboarded} onboarded, ${ids.length - onboarded} not.`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
