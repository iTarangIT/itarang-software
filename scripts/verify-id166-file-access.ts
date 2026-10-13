/**
 * Read-only check of the ID 166 file rule against real rows: for a few stored
 * customer KYC files and call recordings, who may open them.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id166-file-access.ts
 *
 * Imports the real rule (fileAuthz.canOpenStoredFile) — nothing is restated.
 * Writes nothing (logFileOpen is not called).
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { canOpenStoredFile } from "@/lib/storage/fileAuthz";
import { parseFilesProxyRef } from "@/lib/storage/s3";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

let failures = 0;
function check(label: string, got: boolean, want: boolean) {
    const ok = got === want;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${got ? "opens" : "refused"}`);
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`database host: ${host}\n`);

    const users = rowsOf<{ id: string; role: string; dealer_id: string | null }>(
        await db.execute(sql`SELECT id::text, role, dealer_id FROM users WHERE role IN ('admin','inside_sales_rep','business_head') ORDER BY role`),
    );
    const admin = users.find((u) => u.role === "admin");
    const isr = users.find((u) => u.role === "inside_sales_rep");
    const bh = users.find((u) => u.role === "business_head");

    // Customer KYC files, with the dealer login of the lead's dealership.
    const docs = rowsOf<{ url: string; lead_id: string; dealer_id: string | null }>(
        await db.execute(sql`
            SELECT kd.file_url AS url, l.id AS lead_id, l.dealer_id
              FROM kyc_documents kd JOIN leads l ON l.id = kd.lead_id
             WHERE kd.file_url LIKE '/api/files/documents/kyc/%'
             ORDER BY kd.uploaded_at DESC NULLS LAST
             LIMIT 3
        `),
    );
    for (const d of docs) {
        const ref = parseFilesProxyRef(d.url);
        if (!ref) continue;
        const [own] = rowsOf<{ id: string; role: string; dealer_id: string | null }>(
            await db.execute(sql`SELECT id::text, role, dealer_id FROM users WHERE role = 'dealer' AND dealer_id = ${d.dealer_id} LIMIT 1`),
        );
        const [other] = rowsOf<{ id: string; role: string; dealer_id: string | null }>(
            await db.execute(sql`SELECT id::text, role, dealer_id FROM users WHERE role = 'dealer' AND dealer_id IS NOT NULL AND dealer_id <> ${d.dealer_id ?? ""} LIMIT 1`),
        );
        console.log(`KYC ${ref.key}`);
        if (admin) check("  admin", (await canOpenStoredFile(admin, ref.bucket, ref.key)).allowed, true);
        if (own) check("  its dealer", (await canOpenStoredFile(own, ref.bucket, ref.key)).allowed, true);
        if (other) check("  another dealer", (await canOpenStoredFile(other, ref.bucket, ref.key)).allowed, false);
        if (isr) check("  an ISR (not account owner)", (await canOpenStoredFile(isr, ref.bucket, ref.key)).allowed, false);
        if (bh) check("  business head", (await canOpenStoredFile(bh, ref.bucket, ref.key)).allowed, false);
    }

    // A provider recording and the owner of its dealer lead.
    const recs = rowsOf<{ url: string; owner: string | null }>(
        await db.execute(sql`
            SELECT b.recording_url AS url, dl.current_owner_id::text AS owner
              FROM bolna_calls b JOIN dealer_leads dl ON dl.id = b.lead_id
             WHERE b.recording_url LIKE '%/api/files/call-recordings/%' AND dl.current_owner_id IS NOT NULL
             ORDER BY b.created_at DESC NULLS LAST LIMIT 2
        `),
    );
    for (const r of recs) {
        const ref = parseFilesProxyRef(r.url);
        if (!ref || !r.owner) continue;
        const [owner] = rowsOf<{ id: string; role: string; dealer_id: string | null }>(
            await db.execute(sql`SELECT id::text, role, dealer_id FROM users WHERE id = ${r.owner}::uuid`),
        );
        console.log(`Recording ${ref.key}`);
        if (owner) check(`  lead owner (${owner.role})`, (await canOpenStoredFile(owner, ref.bucket, ref.key)).allowed, true);
        const stranger = users.find((u) => u.role === "inside_sales_rep" && u.id !== r.owner);
        if (stranger) check("  another ISR", (await canOpenStoredFile(stranger, ref.bucket, ref.key)).allowed, false);
    }

    if (docs.length === 0) console.log("(no customer KYC files on this database)");
    if (recs.length === 0) console.log("(no re-hosted Bolna recordings on this database)");
    console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
    process.exit(failures ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
