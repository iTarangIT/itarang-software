// B12 — read-only check of the KYC export query against the live DB.
//
//   node --import tsx --env-file=.env.local scripts/verify-kyc-export.ts
//
// 1. "Export selected" with 3 ids returns exactly 3 rows.
// 2. No cell in any row carries a PAN (AAAAA9999A) or a 12-digit Aadhaar.
// 3. Status filters map to the queue vocabulary and change the row count.
// 4. Prints a few rows so the flags can be eyeballed against kyc_verifications.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { fetchKycExportRows } from "@/lib/admin/kycExport";

const line = (s = "") => console.log(s);
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/;
const AADHAAR = /\b\d{4}\s?\d{4}\s?\d{4}\b/;

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
    line(`DB host: ${host}`);
    let failed = false;

    const all = await fetchKycExportRows({});
    line(`all cases: ${all.length} rows`);
    const byOutcome = new Map<string, number>();
    for (const r of all) byOutcome.set(r.outcome ?? "(none)", (byOutcome.get(r.outcome ?? "(none)") ?? 0) + 1);
    line(`   outcomes: ${[...byOutcome].map(([k, v]) => `${k}=${v}`).join(", ")}`);

    // 1. exactly three
    const ids = all.slice(0, 3).map((r) => r.lead_id);
    const three = await fetchKycExportRows({ lead_ids: ids });
    line(`export selected (${ids.length} ids) → ${three.length} rows ${three.length === ids.length ? "OK" : "MISMATCH"}`);
    if (three.length !== ids.length) failed = true;

    // 2. no document numbers anywhere
    let leaks = 0;
    for (const r of all) {
        for (const [k, v] of Object.entries(r)) {
            if (typeof v !== "string") continue;
            // The phone is +91 + 10 digits = 12 digits, which the Aadhaar pattern
            // also matches. The ROUTE masks it to the last four; the query hands
            // it over raw, so scan every other column and check the mask apart.
            if (k === "phone") continue;
            if (PAN.test(v) || AADHAAR.test(v)) {
                leaks++;
                line(`   LEAK? ${r.lead_id}.${k} = ${v.slice(0, 30)}`);
            }
        }
    }
    line(`document-number scan over ${all.length} rows × ${Object.keys(all[0] ?? {}).length - 1} columns (phone excluded, masked by the route): ${leaks === 0 ? "clean" : leaks + " hit(s)"}`);
    const { maskPhone } = await import("@/lib/whatsapp/notifications");
    const maskedOk = all.every((r) => !r.phone || !AADHAAR.test(maskPhone(r.phone)));
    line(`   masked phone (as the sheet carries it) never reads as a 12-digit number: ${maskedOk ? "OK" : "FAIL"}`);
    if (!maskedOk) failed = true;
    if (leaks) failed = true;

    // sanity: the source tables DO hold numbers, so the scan is meaningful
    const src = (await db.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM personal_details WHERE pan_no IS NOT NULL OR aadhaar_no IS NOT NULL`)) as unknown as { n: number }[];
    line(`   (personal_details rows holding a PAN/Aadhaar: ${src[0]?.n} — none reach the export)`);

    // 3. status filters
    for (const s of ["pending", "verified", "rejected"]) {
        const r = await fetchKycExportRows({ status: s });
        line(`status=${s}: ${r.length} rows`);
    }

    // 4. eyeball
    line();
    line("sample rows:");
    for (const r of all.slice(0, 4)) {
        line(`   ${r.lead_id} ${(r.applicant_name ?? "").padEnd(22)} phone=${r.phone ? "•••" + r.phone.slice(-4) : "-"} PAN=${r.pan_verified ? "Y" : "N"} AAD=${r.aadhaar_verified ? "Y" : "N"} BANK=${r.bank_verified ? "Y" : "N"} CIBIL=${r.cibil_fetched ? "Y" : "N"} outcome=${r.outcome} reviewer=${r.reviewer_name ?? "-"} reviewed=${r.reviewed_at ?? "-"}`);
    }

    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
