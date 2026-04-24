const postgres = require('postgres');
require('dotenv').config({ path: '.env.local' });

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', prepare: false });

async function run() {
    try {
        const before = await sql`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'sold_at'
        `;
        console.log(`[before] leads.sold_at exists:`, before.length > 0);

        await sql`ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sold_at" timestamp with time zone`;

        const after = await sql`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'sold_at'
        `;
        console.log(`[after]  leads.sold_at exists:`, after.length > 0);
        console.log('Done.');
    } catch (err) {
        console.error('FAILED:', err.message);
        process.exitCode = 1;
    } finally {
        await sql.end();
    }
}

run();
