// ID 126 — sandbox check of Number Repair "Repair failed → Lost", on two TEST leads it makes
// itself (never on real leads; it refuses the live database-2 host).
//
//   node --import tsx --env-file=.env.local scripts/verify-number-repair-126.ts
//
// TEST-126-<run>-A has its number flagged dead (in the Number Repair queue): closing it through
// closeLeadAfterFailedRepair must leave it Lost with reason invalid_contact ("Number not
// working"). TEST-126-<run>-B has no flag: the route's rule (inNumberRepair) must refuse it.
// Both are then taken out of every count (is_active=false; B closed as test_lead).

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { closeLeadAfterFailedRepair } from "@/lib/leads/contactability";
import { inNumberRepair } from "@/lib/leads/contactabilityLabels";
import { markLeadLost } from "@/lib/leads/markLost";

function check(ok: boolean, what: string) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) process.exitCode = 1;
}

type Row = { lead_status: string | null; lost_reason: string | null; contactability: string | null; is_active: boolean | null };
const read = async (id: string) =>
    ((await db.execute(sql`
        SELECT lead_status, lost_reason, contactability, is_active FROM dealer_leads WHERE id = ${id}
    `)) as unknown as Row[])[0];

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    if (host.startsWith("database-2")) throw new Error("refusing to run against live (database-2)");
    console.log(`DB host: ${host}\n`);

    const run = Date.now().toString(36);
    const A = `TEST-126-${run}-A`;
    const B = `TEST-126-${run}-B`;
    const [admin] = (await db.execute(sql`SELECT id::text AS id FROM users WHERE role = 'admin' AND is_active LIMIT 1`)) as unknown as Array<{ id: string }>;
    if (!admin) throw new Error("need an active admin on the sandbox");
    const digits = String(Date.now()).slice(-9);

    await db.execute(sql`
        INSERT INTO dealer_leads (id, dealer_name, shop_name, phone, lead_status, created_at, updated_at)
        VALUES (${A}, 'TEST 126 number repair', 'TEST 126 (flagged)', ${`8${digits}`}, 'Assigned_Not_Contacted', NOW(), NOW()),
               (${B}, 'TEST 126 number repair', 'TEST 126 (not flagged)', ${`7${digits}`}, 'Assigned_Not_Contacted', NOW(), NOW())
    `);
    await db.execute(sql`
        UPDATE dealer_leads SET contactability = 'dead_number', contactability_at = NOW(),
               contactability_reason = 'TEST 126: number does not ring'
         WHERE id = ${A}
    `);
    console.log(`Created ${A} (number flagged dead) and ${B} (no flag).\n`);

    const a0 = await read(A);
    const b0 = await read(B);
    check(inNumberRepair(a0), "the flagged lead is in Number Repair");
    check(!inNumberRepair(b0), "the unflagged lead is not — the route refuses 'Repair failed → Lost' on it");

    await closeLeadAfterFailedRepair({ leadId: A, actor: { id: admin.id, role: "admin" }, note: "TEST 126" });
    const a1 = await read(A);
    check(a1.lead_status === "Lost" && a1.lost_reason === "invalid_contact", `closed as Lost / invalid_contact (got ${a1.lead_status} / ${a1.lost_reason})`);
    check(!inNumberRepair(a1), "once Lost it leaves the Number Repair queue");

    // Out of every count: A inactive, B closed as a test lead (ID 233).
    await db.execute(sql`UPDATE dealer_leads SET is_active = false WHERE id = ${A}`);
    await markLeadLost({ leadId: B, actor: { id: admin.id, role: "admin" }, reason: "test_lead", notes: "TEST 126 check" });
    const b1 = await read(B);
    check(b1.lead_status === "Lost" && b1.is_active === false, "the two test leads are out of every count");
}

main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((e) => {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    });
