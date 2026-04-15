/**
 * Final fix: re-migrate scraper_runs with explicit column mapping
 * and proper jsonb casting for string values in jsonb columns.
 */
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

    // --- Fix scraper_runs ---
    console.log('--- Fixing scraper_runs ---');
    await dst.query(`DELETE FROM "scraper_runs"`);

    const data = await src.query(`SELECT * FROM "scraper_runs"`);
    let inserted = 0, errors = 0;

    for (const row of data.rows) {
        const sq = row.search_queries !== null
            ? (typeof row.search_queries === 'string' ? JSON.stringify(row.search_queries) : JSON.stringify(row.search_queries))
            : null;

        try {
            await dst.query(
                `INSERT INTO scraper_runs (id, triggered_by, status, started_at, completed_at, search_queries, total_found, new_leads_saved, duplicates_skipped, error_message, created_at, cleaned_leads, duration_ms)
                 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)`,
                [row.id, row.triggered_by, row.status, row.started_at, row.completed_at, sq, row.total_found, row.new_leads_saved, row.duplicates_skipped, row.error_message, row.created_at, row.cleaned_leads, row.duration_ms]
            );
            inserted++;
        } catch (e) {
            errors++;
            if (errors <= 3) console.log(`  Error ${row.id}: ${e.message}`);
        }
    }
    console.log(`  scraper_runs: ${inserted}/${data.rows.length} rows${errors > 0 ? ` (${errors} errors)` : ''}`);

    // --- Final verification of all tables ---
    console.log('\n--- Final Verification ---');
    const tables = await dst.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
    `);

    let totalRows = 0;
    for (const t of tables.rows) {
        const cnt = await dst.query(`SELECT count(*) AS cnt FROM "${t.table_name}"`);
        const rows = parseInt(cnt.rows[0].cnt);
        totalRows += rows;
        if (rows > 0) console.log(`  ${t.table_name}: ${rows} rows`);
    }
    console.log(`\nTotal: ${tables.rows.length} tables, ${totalRows} rows on AWS RDS`);

    await src.end();
    await dst.end();
    console.log('Done!');
}

run().catch(console.error);
