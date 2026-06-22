// Copy ONLY the production-referenced Supabase objects (from
// scripts/out/prod-doc-manifest.json) into s3://itarang-crm-production.
//
// - Source: production Supabase project (NEXT_PUBLIC_SUPABASE_URL + service key)
// - Dest:   AWS_S3_BUCKET (must be itarang-crm-production), key = "<bucket>/<key>"
// - Copy-only: never deletes from Supabase. Resume-safe (skips objects already in
//   S3). Reports any manifest entry whose bytes are missing from Supabase
//   (a stale DB reference — NOT data loss, just a dangling row) so nothing is
//   silently assumed copied.
//
// Run:
//   node scripts/copy-manifest-to-s3.mjs --dry-run   # plan only
//   node scripts/copy-manifest-to-s3.mjs             # do the copy + verify

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function loadDotEnv(path) {
  if (!existsSync(path)) return false;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
  return true;
}
loadDotEnv(join(ROOT, ".env.local")) || loadDotEnv(join(ROOT, ".env"));

const DRY_RUN = process.argv.includes("--dry-run");
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AWS_REGION = process.env.AWS_REGION;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const CONCURRENCY = 8;

function die(m) { console.error(`\n  ERROR: ${m}\n`); process.exit(1); }
if (!SUPABASE_URL || !SERVICE_KEY) die("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
if (!AWS_REGION) die("Missing AWS_REGION");
if (!AWS_S3_BUCKET) die("Missing AWS_S3_BUCKET");
if (AWS_S3_BUCKET !== "itarang-crm-production")
  die(`Refusing to run: AWS_S3_BUCKET is "${AWS_S3_BUCKET}", expected "itarang-crm-production". Override intentionally if needed.`);
if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) die("Missing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY");

const manifestPath = join(ROOT, "scripts", "out", "prod-doc-manifest.json");
if (!existsSync(manifestPath)) die(`Manifest not found: ${manifestPath}. Run build-prod-doc-manifest.mjs first.`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const s3 = new S3Client({ region: AWS_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });

async function inS3(s3Key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: AWS_S3_BUCKET, Key: s3Key })); return true; }
  catch { return false; }
}

const stats = { copied: 0, skipped: 0, missing: 0, failed: 0 };
const missing = [];   // referenced by DB but absent from Supabase storage
const failed = [];

async function handle(entry) {
  const { bucket, key } = entry;
  const s3Key = `${bucket}/${key}`;
  if (await inS3(s3Key)) { stats.skipped++; return; }
  if (DRY_RUN) { stats.copied++; return; }

  const { data, error } = await supabase.storage.from(bucket).download(key);
  if (error || !data) { stats.missing++; missing.push(s3Key); return; }
  const buf = Buffer.from(await data.arrayBuffer());
  try {
    await s3.send(new PutObjectCommand({
      Bucket: AWS_S3_BUCKET, Key: s3Key, Body: buf,
      ContentType: data.type || "application/octet-stream",
    }));
    stats.copied++;
    if (stats.copied % 25 === 0) console.log(`  ...${stats.copied} copied`);
  } catch (e) { stats.failed++; failed.push(`${s3Key}: ${e.message}`); }
}

// Verify pass: confirm every manifest entry (that exists in Supabase) is now in S3.
async function verify() {
  let present = 0;
  const absent = [];
  let i = 0;
  async function worker() {
    while (i < manifest.length) {
      const e = manifest[i++];
      const s3Key = `${e.bucket}/${e.key}`;
      if (await inS3(s3Key)) present++;
      else if (!missing.includes(s3Key)) absent.push(s3Key); // absent & not a known-missing source
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { present, absent };
}

async function main() {
  console.log(`Manifest: ${manifest.length} objects  ->  s3://${AWS_S3_BUCKET} (${AWS_REGION})${DRY_RUN ? "  [DRY RUN]" : ""}`);
  let idx = 0;
  async function worker() { while (idx < manifest.length) await handle(manifest[idx++]); }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nCopy: ${stats.copied} copied, ${stats.skipped} already-present, ${stats.missing} missing-in-supabase, ${stats.failed} failed`);
  if (missing.length) {
    const p = join(ROOT, "scripts", "out", "prod-doc-missing-in-supabase.json");
    writeFileSync(p, JSON.stringify(missing, null, 2));
    console.log(`  ${missing.length} referenced object(s) are absent from Supabase (stale DB rows). Listed in ${p}`);
  }
  if (failed.length) { console.log("  FAILURES:"); for (const f of failed) console.log(`    - ${f}`); }

  if (!DRY_RUN) {
    const { present, absent } = await verify();
    console.log(`\nVerify: ${present}/${manifest.length} manifest objects confirmed in S3 (${missing.length} expected-absent = stale source).`);
    if (absent.length) {
      console.log(`  ⚠ ${absent.length} object(s) neither copied nor known-missing — INVESTIGATE:`);
      for (const a of absent.slice(0, 50)) console.log(`    - ${a}`);
    } else {
      console.log(`  ✅ Every production-referenced object that exists in Supabase is present in itarang-crm-production.`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
