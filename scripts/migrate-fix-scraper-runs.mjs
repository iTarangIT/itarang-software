/**
 * Fix scraper_runs: debug and fix JSON serialization
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

    // Get all column types for scraper_runs
    const colTypes = await src.query(`
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'scraper_runs'
        ORDER BY ordinal_position
    `);
    console.log('scraper_runs columns:');
    for (const col of colTypes.rows) {
        console.log(`  ${col.column_name}: ${col.data_type} (${col.udt_name})`);
    }

    // Clear and re-insert with aggressive JSON serialization
    await dst.query(`DELETE FROM "scraper_runs"`);
    console.log('\nCleared scraper_runs on RDS.');

    const jsonishTypes = new Set(['json', 'jsonb', '_text', '_varchar', '_int4', '_int8', '_float8']);
    const jsonCols = new Set(colTypes.rows.filter(c => jsonishTypes.has(c.udt_name)).map(c => c.column_name));
    console.log('JSON-ish columns:', [...jsonCols]);

    const data = await src.query(`SELECT * FROM "scraper_runs"`);
    let inserted = 0;
    let errors = 0;

    for (const row of data.rows) {
        const keys = Object.keys(row);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const colNames = keys.map(k => `"${k}"`).join(', ');
        const values = keys.map(k => {
            const val = row[k];
            if (val instanceof Date) {
                return val; // keep Date objects as-is for timestamptz
            }
            if (val !== null && typeof val === 'object') {
                return JSON.stringify(val);
            }
            return val;
        });

        try {
            await dst.query(`INSERT INTO "scraper_runs" (${colNames}) VALUES (${placeholders})`, values);
            inserted++;
        } catch (e) {
            errors++;
            if (errors <= 5) {
                // Find which value is problematic
                console.log(`  Error row id=${row.id}: ${e.message}`);
                for (const k of keys) {
                    if (typeof row[k] === 'object' && row[k] !== null) {
                        console.log(`    ${k} type=${typeof row[k]} isArray=${Array.isArray(row[k])} val=${JSON.stringify(row[k]).substring(0, 100)}`);
                    }
                }
            }
        }
    }

    console.log(`\nResult: ${inserted}/${data.rows.length} rows (${errors} errors)`);

    await src.end();
    await dst.end();
}

run().catch(console.error);
