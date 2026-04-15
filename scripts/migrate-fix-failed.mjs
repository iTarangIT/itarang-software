/**
 * Fix migration: re-migrate tables that failed due to JSON serialization
 * and the users table that had 0 rows copied.
 * Usage: node scripts/migrate-fix-failed.mjs
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

const TABLES_TO_FIX = ['users', 'dealer_leads', 'leads', 'scraper_runs'];

async function run() {
    const src = new Client({ connectionString: SOURCE_URL, ssl: { rejectUnauthorized: false } });
    const dst = new Client(TARGET);

    console.log('Connecting to Supabase (source)...');
    await src.connect();
    console.log('Connecting to AWS RDS (target)...');
    await dst.connect();
    console.log('Connected to both.\n');

    // Step 1: Get JSON/JSONB column info for all tables
    const jsonColsResult = await src.query(`
        SELECT table_name, column_name, udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
          AND udt_name IN ('json', 'jsonb')
        ORDER BY table_name, ordinal_position
    `, [TABLES_TO_FIX]);

    const jsonCols = {};
    for (const row of jsonColsResult.rows) {
        if (!jsonCols[row.table_name]) jsonCols[row.table_name] = [];
        jsonCols[row.table_name].push(row.column_name);
    }
    console.log('JSON columns per table:');
    for (const [table, cols] of Object.entries(jsonCols)) {
        console.log(`  ${table}: ${cols.join(', ')}`);
    }
    console.log();

    // Step 2: Clear and re-insert data for each failed table
    for (const table of TABLES_TO_FIX) {
        console.log(`--- Fixing: ${table} ---`);

        // Clear existing partial data
        try {
            await dst.query(`DELETE FROM "${table}"`);
            console.log(`  Cleared existing rows.`);
        } catch (e) {
            console.log(`  Clear failed: ${e.message}`);
        }

        // Count source rows
        const countResult = await src.query(`SELECT count(*) AS cnt FROM "${table}"`);
        const count = parseInt(countResult.rows[0].cnt);
        console.log(`  Source has ${count} rows.`);

        if (count === 0) {
            console.log(`  Skipped (empty).`);
            continue;
        }

        const tableJsonCols = jsonCols[table] || [];
        const BATCH = 500;
        let offset = 0;
        let inserted = 0;
        let errors = 0;

        while (offset < count) {
            const dataResult = await src.query(`SELECT * FROM "${table}" LIMIT ${BATCH} OFFSET ${offset}`);
            if (dataResult.rows.length === 0) break;

            for (const row of dataResult.rows) {
                const keys = Object.keys(row);
                const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
                const colNames = keys.map(k => `"${k}"`).join(', ');

                // Serialize JSON/JSONB columns properly
                const values = keys.map(k => {
                    const val = row[k];
                    if (tableJsonCols.includes(k) && val !== null && typeof val === 'object') {
                        return JSON.stringify(val);
                    }
                    return val;
                });

                try {
                    await dst.query(`INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`, values);
                    inserted++;
                } catch (e) {
                    if (!e.message.includes('duplicate key')) {
                        errors++;
                        if (errors <= 3) {
                            console.log(`    Row error: ${e.message}`);
                        }
                    }
                }
            }
            offset += BATCH;
        }

        console.log(`  Result: ${inserted}/${count} rows inserted${errors > 0 ? `, ${errors} errors` : ''}`);
    }

    // Step 3: Fix sequences
    console.log('\n--- Resetting sequences ---');
    const seqResult = await src.query(`
        SELECT sequencename AS sequence_name
        FROM pg_sequences
        WHERE schemaname = 'public'
    `);

    for (const row of seqResult.rows) {
        try {
            const valResult = await src.query(`SELECT last_value FROM "${row.sequence_name}"`);
            const lastVal = valResult.rows[0].last_value;
            if (lastVal) {
                await dst.query(`SELECT setval('"${row.sequence_name}"', ${lastVal}, true)`);
                console.log(`  Sequence: ${row.sequence_name} = ${lastVal}`);
            }
        } catch (e) {
            console.log(`  Sequence ${row.sequence_name} skipped: ${e.message}`);
        }
    }

    // Step 4: Verify
    console.log('\n--- Verifying fixed tables ---');
    for (const table of TABLES_TO_FIX) {
        try {
            const result = await dst.query(`SELECT count(*) AS cnt FROM "${table}"`);
            console.log(`  ${table}: ${result.rows[0].cnt} rows on RDS`);
        } catch (e) {
            console.log(`  ${table}: VERIFY FAILED - ${e.message}`);
        }
    }

    // Step 5: Overall table count
    const allTables = await dst.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
    `);
    console.log(`\nTotal tables on AWS RDS: ${allTables.rows.length}`);

    await src.end();
    await dst.end();
    console.log('\nFix migration complete!');
}

run().catch(err => {
    console.error('Fix migration failed:', err);
    process.exit(1);
});
