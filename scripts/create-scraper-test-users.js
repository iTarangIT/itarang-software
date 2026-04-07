/**
 * Creates test users for the Dealer Lead Scraper feature:
 *   - sales.head@itarang.com   (role: sales_head)   — to run scraper & assign leads
 *   - sales.manager@itarang.com (role: sales_manager) — to receive & explore assigned leads
 *
 * Usage: node scripts/create-scraper-test-users.js
 * Requires: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

const TEST_USERS = [
    {
        email: 'sales.head@itarang.com',
        password: 'password',
        name: 'Priya Singh',
        role: 'sales_head',
        phone: '+919876500003',
    },
    {
        email: 'sales.manager@itarang.com',
        password: 'password',
        name: 'Ravi Sharma',
        role: 'sales_manager',
        phone: '+919876500010',
    },
];

async function run() {
    console.log('🚀 Creating / updating test users for Dealer Lead Scraper...\n');

    for (const u of TEST_USERS) {
        console.log(`\n📧 Processing: ${u.email} (${u.role})`);

        // 1. Check if the Supabase Auth user already exists
        const { data: { users: authUsers }, error: listErr } =
            await supabase.auth.admin.listUsers({ perPage: 1000 });

        if (listErr) {
            console.error('  ❌ Could not list auth users:', listErr.message);
            continue;
        }

        let authId;
        const existing = authUsers.find(a => a.email === u.email);

        if (existing) {
            // Update the password
            const { error: updateErr } = await supabase.auth.admin.updateUserById(
                existing.id,
                { password: u.password }
            );
            if (updateErr) {
                console.error('  ❌ Failed to set password:', updateErr.message);
                continue;
            }
            authId = existing.id;
            console.log('  ✅ Auth user exists — password updated to "password"');
        } else {
            // Create the Auth user
            const { data: created, error: createErr } =
                await supabase.auth.admin.createUser({
                    email: u.email,
                    password: u.password,
                    email_confirm: true,
                });
            if (createErr) {
                console.error('  ❌ Failed to create auth user:', createErr.message);
                continue;
            }
            authId = created.user.id;
            console.log('  ✅ Auth user created');
        }

        // 2. Upsert into public.users table
        const { error: dbErr } = await supabase.from('users').upsert(
            {
                id: authId,
                email: u.email,
                name: u.name,
                role: u.role,
                phone: u.phone,
                is_active: true,
            },
            { onConflict: 'id' }
        );

        if (dbErr) {
            console.error('  ❌ DB upsert failed:', dbErr.message);
        } else {
            console.log(`  ✅ public.users record ready (id: ${authId})`);
        }

        // 3. Quick login test
        const { error: loginErr } = await supabase.auth.signInWithPassword({
            email: u.email,
            password: u.password,
        });

        if (loginErr) {
            console.error('  ⚠️  Login test failed:', loginErr.message);
        } else {
            console.log('  🎉 Login verified');
        }
    }

    console.log('\n──────────────────────────────────────────');
    console.log('Test credentials:');
    TEST_USERS.forEach(u =>
        console.log(`  ${u.role.padEnd(15)} │ ${u.email} │ password`)
    );
    console.log('──────────────────────────────────────────\n');
    process.exit(0);
}

run().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
