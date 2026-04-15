import pg from 'pg';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const caCert = fs.readFileSync(path.join(__dirname, '..', 'global-bundle.pem')).toString();

const SOURCE_URL = 'postgresql://postgres.zziynfmqfvchkheqnqqr:MYsupabase%402026@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres';
const TARGET = {
    host: 'database-supabase.c9w88wq6qyco.ap-south-1.rds.amazonaws.com',
    port: 5432,
    user: 'postgres',
    password: 'Rushikesh8208',
    database: 'postgres',
    ssl: { rejectUnauthorized: false, ca: caCert },
};

async function run() {
    const src = new Client({ connectionString: SOURCE_URL, ssl: { rejectUnauthorized: false } });
    const dst = new Client(TARGET);
    await src.connect();
    await dst.connect();

    // Compare column types
    console.log('--- Source (Supabase) columns ---');
    const srcCols = await src.query(`SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='scraper_runs' ORDER BY ordinal_position`);
    for (const c of srcCols.rows) console.log(`  ${c.column_name}: ${c.data_type} (${c.udt_name})`);

    console.log('\n--- Target (RDS) columns ---');
    const dstCols = await dst.query(`SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='scraper_runs' ORDER BY ordinal_position`);
    for (const c of dstCols.rows) console.log(`  ${c.column_name}: ${c.data_type} (${c.udt_name})`);

    // Try a single failing row with explicit cast
    const failRow = await src.query(`SELECT * FROM scraper_runs WHERE id = 'SCRAPE-20260325-024'`);
    if (failRow.rows.length > 0) {
        const row = failRow.rows[0];
        console.log('\n--- Failing row sample ---');
        console.log('search_queries type:', typeof row.search_queries, 'value:', JSON.stringify(row.search_queries).substring(0, 200));

        // Try inserting with explicit text cast for search_queries
        await dst.query(`DELETE FROM scraper_runs WHERE id = $1`, [row.id]);
        try {
            const sq = row.search_queries !== null ? JSON.stringify(row.search_queries) : null;
            await dst.query(
                `INSERT INTO scraper_runs (id, triggered_by, status, started_at, completed_at, search_queries, total_found, new_leads_saved, duplicates_skipped, error_message, created_at, cleaned_leads, duration_ms)
                 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)`,
                [row.id, row.triggered_by, row.status, row.started_at, row.completed_at, sq, row.total_found, row.new_leads_saved, row.duplicates_skipped, row.error_message, row.created_at, row.cleaned_leads, row.duration_ms]
            );
            console.log('SUCCESS with explicit column mapping!');
        } catch (e) {
            console.log('STILL FAILED:', e.message);
        }
    }

    await src.end();
    await dst.end();
}
run().catch(console.error);
