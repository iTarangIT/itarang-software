const { createClient } = require('@supabase/supabase-js');
const { Client } = require('pg');
require('dotenv').config({ path: '.env.local' });

async function run() {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();

    const { rows: rdsUsers } = await pg.query('SELECT id, email, role FROM users');
    const byEmail = new Map(rdsUsers.map(u => [u.email.toLowerCase(), u.role]));

    const { data: { users: authUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });

    let updated = 0, skipped = 0, missing = 0;
    for (const au of authUsers) {
        const role = byEmail.get((au.email || '').toLowerCase());
        if (!role) { missing++; continue; }
        if (au.app_metadata?.role === role) { skipped++; continue; }
        await supabase.auth.admin.updateUserById(au.id, {
            app_metadata: { ...(au.app_metadata || {}), role },
        });
        console.log(`  updated ${au.email} -> ${role}`);
        updated++;
    }

    console.log(`\nDone. updated=${updated}, already-synced=${skipped}, no-rds-row=${missing}`);
    await pg.end();
}

run().catch(e => { console.error(e); process.exit(1); });
