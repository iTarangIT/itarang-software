/**
 * Migrate all public schema tables from Supabase to AWS RDS
 * Usage: node scripts/migrate-supabase-to-aws.mjs
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

    console.log('Connecting to Supabase (source)...');
    await src.connect();
    console.log('Connected to Supabase.');

    console.log('Connecting to AWS RDS (target)...');
    await dst.connect();
    console.log('Connected to AWS RDS.');

    // ─── Step 1: Get all enums ─────────────────────────────────────────────
    console.log('\n--- Migrating enums ---');
    const enumsResult = await src.query(`
        SELECT t.typname AS enum_name,
               string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS enum_values
        FROM pg_type t
        JOIN pg_enum e ON t.oid = e.enumtypid
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE n.nspname = 'public'
        GROUP BY t.typname
    `);

    for (const row of enumsResult.rows) {
        const values = row.enum_values.split(',').map(v => `'${v}'`).join(', ');
        const sql = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${row.enum_name}') THEN CREATE TYPE "${row.enum_name}" AS ENUM (${values}); END IF; END $$;`;
        try {
            await dst.query(sql);
            console.log(`  Enum: ${row.enum_name}`);
        } catch (e) {
            console.log(`  Enum ${row.enum_name} skipped: ${e.message}`);
        }
    }

    // ─── Step 2: Get all extensions used ───────────────────────────────────
    console.log('\n--- Migrating extensions ---');
    const extResult = await src.query(`SELECT extname FROM pg_extension WHERE extname != 'plpgsql'`);
    for (const row of extResult.rows) {
        try {
            await dst.query(`CREATE EXTENSION IF NOT EXISTS "${row.extname}" CASCADE`);
            console.log(`  Extension: ${row.extname}`);
        } catch (e) {
            console.log(`  Extension ${row.extname} skipped: ${e.message}`);
        }
    }

    // ─── Step 3: Get table creation order (respecting FK dependencies) ─────
    console.log('\n--- Getting tables ---');
    const tablesResult = await src.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
    `);
    const allTables = tablesResult.rows.map(r => r.table_name);
    console.log(`  Found ${allTables.length} tables: ${allTables.join(', ')}`);

    // ─── Step 4: Get full DDL for each table ──────────────────────────────
    console.log('\n--- Creating tables on AWS RDS ---');

    // Drop all tables first (in reverse FK order)
    const fkOrder = await src.query(`
        SELECT DISTINCT tc.table_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    `);
    const tablesWithFK = new Set(fkOrder.rows.map(r => r.table_name));

    // Drop all tables (CASCADE handles FK deps)
    for (const table of allTables) {
        try {
            await dst.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
        } catch (e) { /* ignore */ }
    }

    // Get and execute CREATE TABLE statements
    for (const table of allTables) {
        try {
            // Get column definitions
            const colsResult = await src.query(`
                SELECT column_name, data_type, udt_name, character_maximum_length,
                       numeric_precision, numeric_scale, is_nullable, column_default,
                       is_identity, identity_generation
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = $1
                ORDER BY ordinal_position
            `, [table]);

            const cols = colsResult.rows.map(col => {
                let type;
                if (col.data_type === 'USER-DEFINED') {
                    type = `"${col.udt_name}"`;
                } else if (col.data_type === 'character varying') {
                    type = col.character_maximum_length ? `varchar(${col.character_maximum_length})` : 'varchar';
                } else if (col.data_type === 'numeric') {
                    type = col.numeric_precision ? `numeric(${col.numeric_precision},${col.numeric_scale || 0})` : 'numeric';
                } else if (col.udt_name === 'uuid') {
                    type = 'uuid';
                } else if (col.udt_name === 'jsonb') {
                    type = 'jsonb';
                } else if (col.udt_name === 'json') {
                    type = 'json';
                } else if (col.udt_name === 'timestamptz') {
                    type = 'timestamptz';
                } else if (col.udt_name === 'timestamp') {
                    type = 'timestamp';
                } else if (col.udt_name === 'int4') {
                    type = 'integer';
                } else if (col.udt_name === 'int8') {
                    type = 'bigint';
                } else if (col.udt_name === 'int2') {
                    type = 'smallint';
                } else if (col.udt_name === 'float8') {
                    type = 'double precision';
                } else if (col.udt_name === 'float4') {
                    type = 'real';
                } else if (col.udt_name === 'bool') {
                    type = 'boolean';
                } else {
                    type = col.data_type;
                }

                let def = '';
                if (col.column_default) {
                    // Skip Supabase auth-specific defaults
                    if (!col.column_default.includes('auth.')) {
                        def = ` DEFAULT ${col.column_default}`;
                    }
                }

                const nullable = col.is_nullable === 'NO' ? ' NOT NULL' : '';

                return `  "${col.column_name}" ${type}${def}${nullable}`;
            });

            const createSQL = `CREATE TABLE "${table}" (\n${cols.join(',\n')}\n)`;
            await dst.query(createSQL);
            console.log(`  Created: ${table} (${colsResult.rows.length} columns)`);
        } catch (e) {
            console.error(`  FAILED creating ${table}: ${e.message}`);
        }
    }

    // ─── Step 5: Copy data ────────────────────────────────────────────────
    console.log('\n--- Copying data ---');
    for (const table of allTables) {
        try {
            const countResult = await src.query(`SELECT count(*) AS cnt FROM "${table}"`);
            const count = parseInt(countResult.rows[0].cnt);

            if (count === 0) {
                console.log(`  ${table}: 0 rows (skipped)`);
                continue;
            }

            // Fetch all rows
            const BATCH = 500;
            let offset = 0;
            let inserted = 0;

            while (offset < count) {
                const dataResult = await src.query(`SELECT * FROM "${table}" LIMIT ${BATCH} OFFSET ${offset}`);
                if (dataResult.rows.length === 0) break;

                for (const row of dataResult.rows) {
                    const keys = Object.keys(row);
                    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
                    const values = keys.map(k => row[k]);
                    const colNames = keys.map(k => `"${k}"`).join(', ');

                    try {
                        await dst.query(`INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`, values);
                        inserted++;
                    } catch (e) {
                        // Skip duplicate key errors silently
                        if (!e.message.includes('duplicate key')) {
                            console.error(`    Row insert error in ${table}: ${e.message}`);
                        }
                    }
                }
                offset += BATCH;
            }

            console.log(`  ${table}: ${inserted}/${count} rows`);
        } catch (e) {
            console.error(`  FAILED copying ${table}: ${e.message}`);
        }
    }

    // ─── Step 6: Add primary keys ─────────────────────────────────────────
    console.log('\n--- Adding primary keys ---');
    const pkResult = await src.query(`
        SELECT tc.table_name, string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS pk_cols
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
        GROUP BY tc.table_name, tc.constraint_name
    `);

    for (const row of pkResult.rows) {
        const cols = row.pk_cols.split(',').map(c => `"${c}"`).join(', ');
        try {
            await dst.query(`ALTER TABLE "${row.table_name}" ADD PRIMARY KEY (${cols})`);
            console.log(`  PK: ${row.table_name} (${row.pk_cols})`);
        } catch (e) {
            console.log(`  PK ${row.table_name} skipped: ${e.message}`);
        }
    }

    // ─── Step 7: Add unique constraints ───────────────────────────────────
    console.log('\n--- Adding unique constraints ---');
    const uniqResult = await src.query(`
        SELECT tc.table_name, tc.constraint_name,
               string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS cols
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = 'public'
        GROUP BY tc.table_name, tc.constraint_name
    `);

    for (const row of uniqResult.rows) {
        const cols = row.cols.split(',').map(c => `"${c}"`).join(', ');
        try {
            await dst.query(`ALTER TABLE "${row.table_name}" ADD CONSTRAINT "${row.constraint_name}" UNIQUE (${cols})`);
            console.log(`  Unique: ${row.table_name} (${row.cols})`);
        } catch (e) {
            console.log(`  Unique ${row.table_name} skipped: ${e.message}`);
        }
    }

    // ─── Step 8: Add foreign keys ─────────────────────────────────────────
    console.log('\n--- Adding foreign keys ---');
    const fkResult = await src.query(`
        SELECT tc.table_name, tc.constraint_name,
               kcu.column_name,
               ccu.table_name AS foreign_table_name,
               ccu.column_name AS foreign_column_name,
               rc.delete_rule, rc.update_rule
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
        JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    `);

    for (const row of fkResult.rows) {
        const onDelete = row.delete_rule !== 'NO ACTION' ? ` ON DELETE ${row.delete_rule}` : '';
        const onUpdate = row.update_rule !== 'NO ACTION' ? ` ON UPDATE ${row.update_rule}` : '';
        try {
            await dst.query(`ALTER TABLE "${row.table_name}" ADD CONSTRAINT "${row.constraint_name}" FOREIGN KEY ("${row.column_name}") REFERENCES "${row.foreign_table_name}" ("${row.foreign_column_name}")${onDelete}${onUpdate}`);
            console.log(`  FK: ${row.table_name}.${row.column_name} -> ${row.foreign_table_name}.${row.foreign_column_name}`);
        } catch (e) {
            console.log(`  FK ${row.constraint_name} skipped: ${e.message}`);
        }
    }

    // ─── Step 9: Add indexes ──────────────────────────────────────────────
    console.log('\n--- Adding indexes ---');
    const idxResult = await src.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname NOT LIKE '%_pkey'
          AND indexdef NOT LIKE '%UNIQUE%'
        ORDER BY tablename
    `);

    for (const row of idxResult.rows) {
        try {
            await dst.query(row.indexdef);
            console.log(`  Index: ${row.indexname}`);
        } catch (e) {
            console.log(`  Index ${row.indexname} skipped: ${e.message}`);
        }
    }

    // ─── Step 10: Reset sequences ─────────────────────────────────────────
    console.log('\n--- Resetting sequences ---');
    const seqResult = await src.query(`
        SELECT sequence_name, last_value FROM information_schema.sequences
        WHERE sequence_schema = 'public'
    `);

    for (const row of seqResult.rows) {
        try {
            const valResult = await src.query(`SELECT last_value FROM "${row.sequence_name}"`);
            const lastVal = valResult.rows[0].last_value;
            await dst.query(`SELECT setval('"${row.sequence_name}"', ${lastVal}, true)`);
            console.log(`  Sequence: ${row.sequence_name} = ${lastVal}`);
        } catch (e) {
            console.log(`  Sequence ${row.sequence_name} skipped: ${e.message}`);
        }
    }

    // ─── Done ─────────────────────────────────────────────────────────────
    console.log('\n--- Verifying ---');
    const verifyResult = await dst.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
    `);
    console.log(`AWS RDS has ${verifyResult.rows.length} tables: ${verifyResult.rows.map(r => r.table_name).join(', ')}`);

    await src.end();
    await dst.end();
    console.log('\nMigration complete!');
}

run().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
