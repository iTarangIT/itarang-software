/**
 * Seeds 6 synthetic dealer_leads rows covering every Inside Sales workflow
 * state, so Module 1's queue tabs and Lead Detail UI all have data to work
 * with end-to-end.
 *
 * Owner = sweety.itarang@gmail.com (seeded by scripts/seed-inside-sales-rep-user.js).
 *
 * Idempotent — re-running first deletes any prior DL-IS-TEST-* rows (and
 * their touchpoints/commercials/status-history) before re-inserting.
 *
 * Usage: node scripts/seed-inside-sales-test-leads.js
 * Requires .env.local: DATABASE_URL
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const postgres = require('postgres');
require('dotenv').config({ path: '.env.local' });

const sql = postgres(process.env.DATABASE_URL, {
    ssl: { rejectUnauthorized: false },
    max: 1,
});

const OWNER_EMAIL = 'sweety.itarang@gmail.com';
const ASM_EMAIL = 'asm.itarang@gmail.com';

const SEEDS = [
    {
        id: 'DL-IS-TEST-001',
        dealer_name: 'Bharat Auto Electric',
        shop_name: 'Bharat Auto · Faridabad',
        phone: '+919999000101',
        city: 'Faridabad',
        state: 'Haryana',
        language: 'Hindi',
        final_intent_score: 88,
        lead_status: 'New_Unassigned',
        interest_level: 'hot',
        owned: false,
    },
    {
        id: 'DL-IS-TEST-002',
        dealer_name: 'Sundaram E-Rick',
        shop_name: 'Sundaram E-Rick · Madurai',
        phone: '+919999000102',
        city: 'Madurai',
        state: 'Tamil Nadu',
        language: 'Tamil',
        final_intent_score: 76,
        lead_status: 'Assigned_Not_Contacted',
        interest_level: 'warm',
        owned: true,
    },
    {
        id: 'DL-IS-TEST-003',
        dealer_name: 'Kohli Battery House',
        shop_name: 'Kohli Battery · Ludhiana',
        phone: '+919999000103',
        city: 'Ludhiana',
        state: 'Punjab',
        language: 'Punjabi',
        final_intent_score: 82,
        lead_status: 'Under_Discussion',
        interest_level: 'hot',
        owned: true,
        engaged_touchpoint: true,
    },
    {
        id: 'DL-IS-TEST-004',
        dealer_name: 'Patel Motors',
        shop_name: 'Patel Motors · Ahmedabad',
        phone: '+919999000104',
        city: 'Ahmedabad',
        state: 'Gujarat',
        language: 'Gujarati',
        final_intent_score: 84,
        lead_status: 'Commercials_Explained',
        interest_level: 'hot',
        owned: true,
        commercials: { event_type: 'quote_issue', price_quoted: 85000, final_price: null },
    },
    {
        id: 'DL-IS-TEST-005',
        dealer_name: 'Anand E-Vehicles',
        shop_name: 'Anand E-Vehicles · Pune',
        phone: '+919999000105',
        city: 'Pune',
        state: 'Maharashtra',
        language: 'Marathi',
        final_intent_score: 91,
        lead_status: 'Commercials_Finalised',
        interest_level: 'order_placed',
        owned: true,
        commercials: { event_type: 'final_terms', price_quoted: 82000, final_price: 80000 },
    },
    {
        id: 'DL-IS-TEST-006',
        dealer_name: 'GreenWheel Distributors',
        shop_name: 'GreenWheel · Bengaluru',
        phone: '+919999000106',
        city: 'Bengaluru',
        state: 'Karnataka',
        language: 'Kannada',
        final_intent_score: 65,
        lead_status: 'Lost',
        interest_level: 'cold',
        owned: true,
        lost_reason: 'not_interested',
        closed: true,
    },
];

async function run() {
    console.log('Seeding inside-sales test leads…');
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set');
        process.exit(1);
    }

    const owners = await sql`SELECT id::text AS id FROM users WHERE email = ${OWNER_EMAIL} LIMIT 1`;
    const ownerId = owners[0]?.id;
    if (!ownerId) {
        console.error(`Owner ${OWNER_EMAIL} not found. Run scripts/seed-inside-sales-rep-user.js first.`);
        process.exit(1);
    }
    console.log(`  owner: ${OWNER_EMAIL} (${ownerId})`);

    // Look up the test ASM and seed territory rows so they show in-territory
    // in the Transfer-to-ASM dropdown. Without this the dropdown is empty until
    // you toggle "Show all ASMs (out-of-territory)".
    const asms = await sql`SELECT id::text AS id FROM users WHERE email = ${ASM_EMAIL} LIMIT 1`;
    const asmId = asms[0]?.id;
    if (asmId) {
        const seedStates = [...new Set(SEEDS.map((s) => s.state))];
        await sql`DELETE FROM asm_territories WHERE asm_id = ${asmId} AND state IN ${sql(seedStates)}`;
        for (const state of seedStates) {
            await sql`
                INSERT INTO asm_territories (asm_id, state, city)
                VALUES (${asmId}, ${state}, NULL)
            `;
        }
        console.log(`  asm:   ${ASM_EMAIL} (${asmId}) — covers ${seedStates.length} state(s)`);
    } else {
        console.log(`  asm:   ${ASM_EMAIL} not found (skipped territory seed; run scripts/seed-asm-user.js)`);
    }

    // Clean prior test rows (idempotent re-run).
    const ids = SEEDS.map((s) => s.id);
    await sql`DELETE FROM lead_touchpoints WHERE dealer_lead_id IN ${sql(ids)}`;
    await sql`DELETE FROM dealer_lead_status_history WHERE dealer_lead_id IN ${sql(ids)}`;
    await sql`DELETE FROM dealer_lead_commercials WHERE dealer_lead_id IN ${sql(ids)}`;
    await sql`DELETE FROM dealer_leads WHERE id IN ${sql(ids)}`;

    for (const seed of SEEDS) {
        const owner = seed.owned ? ownerId : null;
        const now = new Date();
        const lastTouch = seed.lead_status === 'New_Unassigned' ? null : new Date(now.getTime() - 1000 * 60 * 60 * 6);
        await sql`
            INSERT INTO dealer_leads (
                id, dealer_name, shop_name, phone, city, state, language,
                final_intent_score, current_status,
                lead_status, ai_recall_status, interest_level,
                current_owner_id, originator_id,
                assigned_at, last_touchpoint_at,
                closed_at, closing_owner_id, closing_role, lost_reason,
                created_at, updated_at, is_active
            ) VALUES (
                ${seed.id}, ${seed.dealer_name}, ${seed.shop_name}, ${seed.phone},
                ${seed.city}, ${seed.state}, ${seed.language},
                ${seed.final_intent_score}, 'ai_qualified',
                ${seed.lead_status}, 'qualified', ${seed.interest_level},
                ${owner}, ${owner},
                ${seed.owned ? new Date(now.getTime() - 1000 * 60 * 60 * 24 * 3) : null},
                ${lastTouch},
                ${seed.closed ? now : null},
                ${seed.closed ? owner : null},
                ${seed.closed ? 'is_phone' : null},
                ${seed.lost_reason ?? null},
                NOW(), NOW(), true
            )
        `;

        // Engaged touchpoint for the Under_Discussion seed.
        if (seed.engaged_touchpoint) {
            await sql`
                INSERT INTO lead_touchpoints (dealer_lead_id, touchpoint_type, performed_by, performed_at, call_status, is_engaged, remarks)
                VALUES (${seed.id}, 'inside_sales_call', ${ownerId}, ${new Date(now.getTime() - 1000 * 60 * 60 * 12)}, 'connected', true, 'Dealer engaged — interested in pilot order')
            `;
            await sql`
                INSERT INTO dealer_lead_status_history (dealer_lead_id, from_status, to_status, changed_by, changed_at)
                VALUES (${seed.id}, 'Assigned_Not_Contacted', 'Under_Discussion', ${ownerId}, ${new Date(now.getTime() - 1000 * 60 * 60 * 12)})
            `;
        }

        // Commercials row for those that need one.
        if (seed.commercials) {
            await sql`
                INSERT INTO dealer_lead_commercials (
                    dealer_lead_id, version_no, is_current, event_type,
                    price_quoted, final_price, payment_method, deal_notes,
                    credit_terms, delivery_terms, warranty_terms,
                    created_by, created_at, updated_at
                ) VALUES (
                    ${seed.id}, 1, true, ${seed.commercials.event_type},
                    ${seed.commercials.price_quoted}, ${seed.commercials.final_price},
                    'finance', '100 units of E-Rick Pro 100Ah, chargers included',
                    '30 days', '15 days FOB Faridabad', '24 months',
                    ${ownerId}, NOW(), NOW()
                )
            `;
        }

        // Lost status history.
        if (seed.lead_status === 'Lost') {
            await sql`
                INSERT INTO dealer_lead_status_history (dealer_lead_id, from_status, to_status, to_lost_reason, changed_by, changed_at)
                VALUES (${seed.id}, 'Under_Discussion', 'Lost', ${seed.lost_reason}, ${ownerId}, ${now})
            `;
        }

        console.log(`  ✓ ${seed.id} · ${seed.lead_status}`);
    }

    console.log('\n──────────────────────────────────────────');
    console.log('  6 test leads ready. Sign in as Sweety to see them.');
    console.log('  Clean up: DELETE FROM dealer_leads WHERE id LIKE \'DL-IS-TEST-%\';');
    console.log('──────────────────────────────────────────\n');

    await sql.end();
    process.exit(0);
}

run().catch(async (err) => {
    console.error('Fatal:', err);
    try { await sql.end(); } catch {}
    process.exit(1);
});
