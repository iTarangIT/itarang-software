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
            WHERE table_schema = 'public'
              AND table_name = 'dealer_onboarding_applications'
              AND column_name = 'stamp_certificate_ids'
        `;
        console.log(`[before] dealer_onboarding_applications.stamp_certificate_ids exists:`, before.length > 0);

        await sql`
            ALTER TABLE "dealer_onboarding_applications"
            ADD COLUMN IF NOT EXISTS "stamp_certificate_ids" JSONB DEFAULT '[]'::jsonb
        `;

        const after = await sql`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'dealer_onboarding_applications'
              AND column_name = 'stamp_certificate_ids'
        `;
        console.log(`[after]  dealer_onboarding_applications.stamp_certificate_ids:`, after[0] || 'MISSING');
        console.log('Done.');
    } catch (err) {
        console.error('FAILED:', err.message);
        process.exitCode = 1;
    } finally {
        await sql.end();
    }
}

run();
