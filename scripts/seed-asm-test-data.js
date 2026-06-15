/**
 * Promotes 3 of the Module 1 test leads into the ASM workflow (Transferred_to_ASM)
 * and seeds a corresponding lead_visits row for each so Module 2's queue tabs
 * (My Active Visits / Today's Schedule) have data to render.
 *
 * Idempotent — re-running first removes any prior ASM-test promotions for these
 * lead ids, then re-promotes.
 *
 * Usage: node scripts/seed-asm-test-data.js
 * Requires: scripts/seed-inside-sales-test-leads.js has been run first.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const postgres = require('postgres');
require('dotenv').config({ path: '.env.local' });

const sql = postgres(process.env.DATABASE_URL, {
    ssl: { rejectUnauthorized: false },
    max: 1,
});

const ASM_EMAIL = 'asm.itarang@gmail.com';

// Promote these 3 — they're owned by Nidhi after Module 1's seed.
//
//   DL-IS-TEST-003 (Kohli, Punjab, Under_Discussion)   → scheduled today
//   DL-IS-TEST-004 (Patel, Gujarat, Commercials_Explained) → visited productive
//   DL-IS-TEST-005 (Anand, Maharashtra, Commercials_Finalised, final_price set)
//                                                       → pending_scheduling
const PROMOTIONS = [
    { lead_id: 'DL-IS-TEST-003', visit_status: 'scheduled', schedule_offset_days: 0 },
    { lead_id: 'DL-IS-TEST-004', visit_status: 'visited', visit_outcome: 'productive', schedule_offset_days: -1 },
    { lead_id: 'DL-IS-TEST-005', visit_status: 'pending_scheduling', schedule_offset_days: null },
];

async function run() {
    console.log('Seeding ASM test data…');
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL not set');
        process.exit(1);
    }

    const asms = await sql`SELECT id::text AS id FROM users WHERE email = ${ASM_EMAIL} LIMIT 1`;
    const asmId = asms[0]?.id;
    if (!asmId) {
        console.error(`ASM ${ASM_EMAIL} not found. Run scripts/seed-asm-user.js first.`);
        process.exit(1);
    }
    console.log(`  asm: ${ASM_EMAIL} (${asmId})`);

    // Clean any prior promotion artifacts for these leads.
    const ids = PROMOTIONS.map((p) => p.lead_id);
    await sql`DELETE FROM lead_visits WHERE dealer_lead_id IN ${sql(ids)}`;
    await sql`
        DELETE FROM dealer_lead_status_history
        WHERE dealer_lead_id IN ${sql(ids)}
          AND (to_status = 'Transferred_to_ASM' OR from_status = 'Transferred_to_ASM')
    `;
    await sql`
        DELETE FROM lead_touchpoints
        WHERE dealer_lead_id IN ${sql(ids)}
          AND touchpoint_type IN ('asm_transfer', 'visit')
    `;

    for (const p of PROMOTIONS) {
        const rows = await sql`
            SELECT id, current_owner_id, lead_status FROM dealer_leads WHERE id = ${p.lead_id} LIMIT 1
        `;
        const lead = rows[0];
        if (!lead) {
            console.log(`  skip ${p.lead_id} — not seeded (run scripts/seed-inside-sales-test-leads.js)`);
            continue;
        }

        const isRepId = lead.current_owner_id;
        const priorStatus = lead.lead_status ?? 'Under_Discussion';

        // Move ownership + status to ASM.
        await sql`
            UPDATE dealer_leads
            SET pre_transfer_status = ${priorStatus},
                current_owner_id = ${asmId},
                asm_id = ${asmId},
                lead_status = 'Transferred_to_ASM',
                assigned_at = NOW(),
                updated_at = NOW(),
                closed_at = NULL,
                closing_owner_id = NULL,
                closing_role = NULL
            WHERE id = ${p.lead_id}
        `;

        // Status history (audit).
        await sql`
            INSERT INTO dealer_lead_status_history (dealer_lead_id, from_status, to_status, changed_by, changed_at, reason_notes)
            VALUES (${p.lead_id}, ${priorStatus}, 'Transferred_to_ASM', ${isRepId ?? asmId}, NOW(), 'Module 2 seed: handoff to test ASM')
        `;

        // Parallel asm_transfer touchpoint.
        await sql`
            INSERT INTO lead_touchpoints (dealer_lead_id, touchpoint_type, performed_by, performed_at, remarks)
            VALUES (${p.lead_id}, 'asm_transfer', ${isRepId ?? asmId}, NOW(),
                ${'Seeded handoff — ' + p.visit_status})
        `;

        // Visit row.
        const scheduledDate =
            p.schedule_offset_days != null
                ? new Date(Date.now() + p.schedule_offset_days * 86_400_000).toISOString().slice(0, 10)
                : null;
        const actualVisitDate = p.visit_status === 'visited' ? scheduledDate : null;
        await sql`
            INSERT INTO lead_visits (
                dealer_lead_id, asm_id, scheduled_date, actual_visit_date,
                visit_status, visit_outcome, visit_remarks,
                next_action
            ) VALUES (
                ${p.lead_id}, ${asmId},
                ${scheduledDate}, ${actualVisitDate},
                ${p.visit_status}, ${p.visit_outcome ?? null},
                ${p.visit_status === 'visited' ? 'Visit completed (seed)' : 'Scheduled (seed)'},
                ${p.visit_status === 'visited' ? 'next_visit' : null}
            )
        `;

        // Parallel 'visit' touchpoint for the visited row (engagement audit).
        if (p.visit_status === 'visited') {
            await sql`
                INSERT INTO lead_touchpoints (dealer_lead_id, touchpoint_type, performed_by, performed_at, is_engaged, remarks)
                VALUES (${p.lead_id}, 'visit', ${asmId}, NOW(), true, 'Productive visit (seed)')
            `;
            await sql`
                UPDATE dealer_leads SET last_touchpoint_at = NOW() WHERE id = ${p.lead_id}
            `;
        }

        console.log(`  ✓ ${p.lead_id} — ${p.visit_status}${scheduledDate ? ` (${scheduledDate})` : ''}`);
    }

    console.log('\n──────────────────────────────────────────');
    console.log('  ASM handoffs ready. Sign in as ASM Test (asm.itarang@gmail.com) → /asm.');
    console.log('──────────────────────────────────────────\n');

    await sql.end();
    process.exit(0);
}

run().catch(async (err) => {
    console.error('Fatal:', err);
    try { await sql.end(); } catch {}
    process.exit(1);
});
