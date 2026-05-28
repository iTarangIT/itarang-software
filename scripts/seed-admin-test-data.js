/**
 * Seeds Module 3 (Admin) test data so every dashboard zone renders non-empty:
 *   - 2 pending escalations on DL-IS-TEST leads (BRD §0.6)
 *   - 1 address-mismatch merge request (BRD §0.4)
 *   - 1 sample upload batch within its 24h rollback window (BRD §0.4)
 *
 * Idempotent — re-running first removes the prior seed artifacts.
 *
 * Usage: node scripts/seed-admin-test-data.js
 * Requires: scripts/seed-inside-sales-test-leads.js has been run first.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const postgres = require('postgres');
require('dotenv').config({ path: '.env.local' });

const sql = postgres(process.env.DATABASE_URL, {
    ssl: { rejectUnauthorized: false },
    max: 1,
});

async function run() {
    console.log('Seeding Module 3 (Admin) test data…');
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL not set');
        process.exit(1);
    }

    // Actor users.
    const admins = await sql`
        SELECT id::text AS id FROM users WHERE LOWER(role) = 'admin' LIMIT 1
    `;
    const anyUser = await sql`
        SELECT id::text AS id FROM users WHERE is_active = TRUE LIMIT 1
    `;
    const adminId = admins[0]?.id ?? anyUser[0]?.id;
    if (!adminId) {
        console.error('No users found in the database.');
        process.exit(1);
    }

    const reps = await sql`
        SELECT id::text AS id, email FROM users
        WHERE email IN ('sweety.itarang@gmail.com', 'asm.itarang@gmail.com')
    `;
    const repId =
        reps.find((r) => r.email.startsWith('sweety'))?.id ?? adminId;

    // Test leads.
    const leads = await sql`
        SELECT id, current_owner_id FROM dealer_leads
        WHERE id LIKE 'DL-IS-TEST-%' ORDER BY id
    `;
    if (leads.length === 0) {
        console.error(
            'No DL-IS-TEST-* leads. Run scripts/seed-inside-sales-test-leads.js first.',
        );
        process.exit(1);
    }
    const ids = leads.map((l) => l.id);

    // Clean prior seed artifacts.
    await sql`DELETE FROM lead_escalations WHERE dealer_lead_id IN ${sql(ids)}`;
    await sql`
        UPDATE dealer_leads
        SET escalation_status = NULL, escalation_count = 0, last_escalation_id = NULL
        WHERE id IN ${sql(ids)}
    `;
    await sql`
        DELETE FROM lead_touchpoints
        WHERE dealer_lead_id IN ${sql(ids)} AND touchpoint_type = 'escalation_raised'
    `;
    await sql`DELETE FROM duplicate_merge_requests WHERE request_notes LIKE 'SEED:%'`;
    await sql`DELETE FROM upload_batches WHERE file_name = 'seed-admin-sample.csv'`;

    // Two pending escalations.
    const escSeeds = [
        {
            lead: leads[0],
            reason: 'Commercial_Decision_Needed',
            urgency: 'high',
            notes:
                'Dealer is asking for a price beyond my approval limit — need admin guidance on the discount.',
        },
        {
            lead: leads[1] ?? leads[0],
            reason: 'Customer_Complaint',
            urgency: 'urgent',
            notes:
                'Dealer raised a serious complaint about a prior delivery; escalating for admin review.',
        },
    ];
    for (const e of escSeeds) {
        const raisedBy = e.lead.current_owner_id ?? repId;
        const rows = await sql`
            INSERT INTO lead_escalations
                (dealer_lead_id, raised_by, raised_at, escalation_reason,
                 escalation_notes, urgency, status)
            VALUES (${e.lead.id}, ${raisedBy}, NOW(), ${e.reason},
                ${e.notes}, ${e.urgency}, 'pending_review')
            RETURNING escalation_id
        `;
        await sql`
            UPDATE dealer_leads SET
                escalation_status = 'pending_review',
                escalation_count = COALESCE(escalation_count, 0) + 1,
                last_escalation_id = ${rows[0].escalation_id},
                updated_at = NOW()
            WHERE id = ${e.lead.id}
        `;
        await sql`
            INSERT INTO lead_touchpoints
                (dealer_lead_id, touchpoint_type, performed_by, performed_at, remarks)
            VALUES (${e.lead.id}, 'escalation_raised', ${raisedBy}, NOW(), ${e.notes})
        `;
        console.log(`  ✓ escalation on ${e.lead.id} (${e.urgency})`);
    }

    // A sample address-mismatch merge request.
    const target = leads[2] ?? leads[0];
    await sql`
        INSERT INTO duplicate_merge_requests
            (request_type, source_lead_id, target_lead_id, requested_by,
             request_notes, status)
        VALUES ('address_mismatch_upload', NULL, ${target.id}, ${adminId},
            ${`SEED: phone matched existing lead ${target.id} but the uploaded address differs — same dealer relocated?`},
            'pending')
    `;
    console.log(`  ✓ merge request on ${target.id}`);

    // A sample upload batch within the 24h rollback window.
    await sql`
        INSERT INTO upload_batches
            (uploaded_by, file_name, total_rows, valid_rows, errored_rows,
             duplicate_rows, routing_to_ai, source_label, status,
             rollback_window_until)
        VALUES (${adminId}, 'seed-admin-sample.csv', 10, 8, 1, 1, false,
            'Seed sample', 'processed', NOW() + INTERVAL '24 hours')
    `;
    console.log('  ✓ sample upload batch');

    console.log('\n──────────────────────────────────────────');
    console.log('  Admin test data ready. Sign in as admin → /admin.');
    console.log('──────────────────────────────────────────\n');

    await sql.end();
    process.exit(0);
}

run().catch(async (err) => {
    console.error('Fatal:', err);
    try {
        await sql.end();
    } catch {}
    process.exit(1);
});
