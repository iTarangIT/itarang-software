// Find a dealer's stored documents and their exact S3 keys.
//
// The S3 object keys contain NO dealer identity, so you can't search S3 for a
// dealer. The mapping lives in database-2 (dealer_onboarding_documents). This
// script looks the dealer up in the DB and prints the precise S3 key for each
// document — paste that key into the S3 console, or use the printed aws CLI cmd.
//
// Usage:
//   node scripts/find-dealer-docs.mjs "EXNON"                 # by company name
//   node scripts/find-dealer-docs.mjs 23CGOPK7140M2ZO         # by GST
//   node scripts/find-dealer-docs.mjs "SALMAN" 4-undated-cheques   # filter doc type
//   node scripts/find-dealer-docs.mjs b4846be7                # by application id (prefix)

import { readFileSync, existsSync } from "node:fs";
import pg from "pg";

function load(p) {
  if (!existsSync(p)) return;
  for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = l.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i < 0) continue;
    const k = t.slice(0, i).trim(); let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
load(".env.local");

const term = process.argv[2];
const docFilter = process.argv[3]; // optional document_type substring
const S3_BUCKET = process.env.AWS_S3_BUCKET || "itarang-crm-production";
const REGION = process.env.AWS_REGION || "ap-south-1";
if (!term) { console.error('Usage: node scripts/find-dealer-docs.mjs "<gst|company|owner|dealer_code|app-id>" [docTypeFilter]'); process.exit(1); }

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const apps = (await c.query(
  `SELECT id, company_name, gst_number, owner_name, owner_email, owner_phone, dealer_code
     FROM dealer_onboarding_applications
    WHERE company_name ILIKE $1 OR gst_number ILIKE $1 OR owner_name ILIKE $1
       OR owner_email ILIKE $1 OR owner_phone ILIKE $1 OR dealer_code ILIKE $1
       OR id::text ILIKE $1
    ORDER BY created_at DESC`,
  [`%${term}%`],
)).rows;

if (!apps.length) { console.log(`No application matches "${term}".`); await c.end(); process.exit(0); }

for (const a of apps) {
  console.log(`\n=== ${a.company_name || "(no name)"}  |  GST ${a.gst_number || "-"}  |  owner ${a.owner_name || "-"}  |  app ${a.id}`);
  const docs = (await c.query(
    `SELECT document_type, file_name, bucket_name, storage_path, file_url
       FROM dealer_onboarding_documents
      WHERE application_id = $1 ${docFilter ? "AND document_type ILIKE $2" : ""}
      ORDER BY document_type, uploaded_at`,
    docFilter ? [a.id, `%${docFilter}%`] : [a.id],
  )).rows;
  if (!docs.length) { console.log("  (no documents" + (docFilter ? ` matching "${docFilter}"` : "") + ")"); continue; }
  for (const d of docs) {
    // S3 key = "<bucket_name>/<storage_path>"; fall back to parsing file_url.
    let key = d.bucket_name && d.storage_path ? `${d.bucket_name}/${d.storage_path}` : null;
    if (!key && d.file_url) {
      const m = d.file_url.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^?]+)/);
      if (m) key = decodeURIComponent(m[1]);
    }
    console.log(`  • ${d.document_type}  (${d.file_name || "?"})`);
    if (key) {
      console.log(`      s3 key : ${key}`);
      console.log(`      s3 uri : s3://${S3_BUCKET}/${key}`);
      console.log(`      console: https://${REGION}.console.aws.amazon.com/s3/object/${S3_BUCKET}?region=${REGION}&prefix=${encodeURIComponent(key)}`);
      console.log(`      cli    : aws s3 cp "s3://${S3_BUCKET}/${key}" .`);
    } else {
      console.log(`      (could not derive S3 key; file_url=${d.file_url || "null"})`);
    }
  }
}
await c.end();
