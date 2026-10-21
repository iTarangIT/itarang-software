/**
 * Read-only check for tracker ID 166 (21 Oct): on every customer lead with KYC
 * files, does the lead's dealer login still see its files under the
 * "own uploads only" rule? Goes through the real dealerViewableFiles(), so it
 * checks exactly what the dealer lists and the file opener decide.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id166-dealer-own-files.ts
 *
 * Writes nothing.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { dealerViewableFiles } from "@/lib/storage/fileAuthz";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`database host: ${host}\n`);
    const leads = rowsOf<{ lead_id: string; dealer_id: string; creator_is_dealer: boolean; urls: string[] }>(
        await db.execute(sql`
            SELECT l.id::text AS lead_id, l.dealer_id,
                   (cu.role = 'dealer' AND cu.dealer_id IS NOT DISTINCT FROM l.dealer_id) AS creator_is_dealer,
                   array_agg(f.url) AS urls
              FROM (
                SELECT lead_id::text AS lead_id, file_url AS url FROM kyc_documents WHERE file_url IS NOT NULL
                UNION ALL SELECT lead_id::text, document_url FROM co_borrower_documents WHERE document_url IS NOT NULL
                UNION ALL SELECT lead_id::text, COALESCE(file_url, document_url) FROM other_document_requests
                           WHERE COALESCE(file_url, document_url) IS NOT NULL
              ) f
              JOIN leads l ON l.id::text = f.lead_id
              LEFT JOIN users cu ON cu.id = l.uploader_id
             WHERE l.dealer_id IS NOT NULL
             GROUP BY 1, 2, 3`),
    );
    let seen = 0, hidden = 0, ownSeen = 0, ownTotal = 0, otherSeen = 0, otherTotal = 0, noLogin = 0;
    for (const l of leads) {
        const dealer = rowsOf<{ id: string }>(
            await db.execute(sql`SELECT id::text FROM users WHERE role = 'dealer' AND dealer_id = ${l.dealer_id} LIMIT 1`),
        )[0];
        if (!dealer) { noLogin += l.urls.length; continue; }
        const can = await dealerViewableFiles({ id: dealer.id, role: "dealer", dealer_id: l.dealer_id }, l.lead_id, l.urls);
        for (const u of l.urls) {
            const ok = can(u);
            ok ? seen++ : hidden++;
            if (l.creator_is_dealer) { ownTotal++; if (ok) ownSeen++; } else { otherTotal++; if (ok) otherSeen++; }
        }
    }
    console.log(`leads with files: ${leads.length}`);
    console.log(`dealer sees: ${seen}   hidden from dealer: ${hidden}   (no dealer login for the lead: ${noLogin})`);
    console.log(`  on leads the dealer created:   ${ownSeen}/${ownTotal} visible (expect all)`);
    console.log(`  on leads someone else created: ${otherSeen}/${otherTotal} visible (expect only files the dealer uploaded)`);
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
