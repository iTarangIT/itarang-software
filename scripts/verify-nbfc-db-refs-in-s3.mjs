// ID 195 / live step L4: before public/nbfc-uploads/ is deleted, find every
// /nbfc-uploads/<key> link stored anywhere in the DB (signed LSP agreements, audit
// trails, compliance docs, signer IDs, FI photos, loan agreements, …) and check
// that nbfc-documents/<key> exists in S3. READ-ONLY on both the DB and S3.
//
//   S3_CHECK_BUCKET=itarang-crm-storage node --env-file=.env.local scripts/verify-nbfc-db-refs-in-s3.mjs

import postgres from "postgres";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";

const bucket = process.env.S3_CHECK_BUCKET || process.env.AWS_S3_BUCKET;
const region = process.env.AWS_REGION;
if (!bucket || !region || !process.env.DATABASE_URL) throw new Error("DATABASE_URL / AWS_S3_BUCKET / AWS_REGION not set");

const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: { rejectUnauthorized: false } });
const s3 = new S3Client({
  region,
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
      : undefined,
});

const host = new URL(process.env.DATABASE_URL).hostname.split(".")[0];
await sql`SET statement_timeout = '60s'`;

// Big tables (telemetry, logs, message history) would take hours to scan and hold
// no NBFC document links; they are listed, not scanned.
const BIG_TABLE_BYTES = 200 * 1024 * 1024;
const bigTables = await sql`
  SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS size
  FROM pg_class
  WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
    AND pg_total_relation_size(oid) > ${BIG_TABLE_BYTES}
  ORDER BY pg_total_relation_size(oid) DESC`;
const big = new Set(bigTables.map((r) => r.relname));

const cols = (
  await sql`
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY')`
).filter((r) => !big.has(r.table_name));

// key -> set of "table.column" it was found in
const refs = new Map();
const skipped = [];
for (const { table_name: t, column_name: c } of cols) {
  try {
    const rows = await sql.unsafe(
      `SELECT DISTINCT m[1] AS key
       FROM (SELECT regexp_matches("${c}"::text, '/nbfc-uploads/([^"\\s,)?#\\\\]+)', 'g') AS m
             FROM "${t}" WHERE "${c}"::text LIKE '%/nbfc-uploads/%') s`,
    );
    for (const { key } of rows) {
      const k = decodeURIComponent(key);
      if (!refs.has(k)) refs.set(k, new Set());
      refs.get(k).add(`${t}.${c}`);
    }
  } catch (e) {
    skipped.push(`${t}.${c} (${e.message.split("\n")[0]})`);
  }
}

const missing = [];
let present = 0;
for (const [k, where] of refs) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: `nbfc-documents/${k}` }));
    present++;
  } catch (err) {
    // 403 = this key cannot read the bucket; stop rather than report a false "missing".
    if (err.$metadata?.httpStatusCode !== 404) throw err;
    missing.push(`${k}   <- ${[...where].join(", ")}`);
  }
}

const byCol = new Map();
for (const where of refs.values()) for (const w of where) byCol.set(w, (byCol.get(w) ?? 0) + 1);

console.log(`DB ${host} vs bucket ${bucket}`);
console.log(`  columns scanned       : ${cols.length - skipped.length} (${skipped.length} skipped)`);
console.log(`  distinct file links   : ${refs.size}`);
console.log(`  in S3                 : ${present}`);
console.log(`  NOT in S3             : ${missing.length}`);
console.log("\nLinks by column:\n  " + [...byCol].sort().map(([w, n]) => `${w}: ${n}`).join("\n  "));
if (missing.length) console.log("\nNot in S3:\n  " + missing.sort().join("\n  "));
if (skipped.length) console.log("\nSkipped columns:\n  " + skipped.join("\n  "));
if (bigTables.length) console.log("\nBig tables not scanned:\n  " + bigTables.map((r) => `${r.relname} (${r.size})`).join("\n  "));
await sql.end();
