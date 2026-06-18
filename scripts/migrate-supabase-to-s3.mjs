// One-off migration: copy EVERY file out of Supabase Storage into AWS S3.
//
// Uses the Supabase SERVICE ROLE key to read (no Supabase S3 access key needed)
// and the AWS IAM user keys to write. Files are NOT deleted from Supabase — this
// is a copy. Re-runnable / resume-safe: any object already present in S3 (same
// key + same size) is skipped, so you can stop and re-run freely.
//
// Layout: each Supabase bucket becomes a prefix in ONE S3 bucket, keys preserved:
//   supabase  documents/foo/bar.pdf
//   ->  s3://<AWS_S3_BUCKET>/documents/foo/bar.pdf
//
// Run:
//   node scripts/migrate-supabase-to-s3.mjs --dry-run     # list only, no upload
//   node scripts/migrate-supabase-to-s3.mjs               # do the copy
//   node scripts/migrate-supabase-to-s3.mjs --bucket documents   # one bucket only
//
// Needs in .env.local (or .env):
//   NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

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
const bucketArgIdx = process.argv.indexOf("--bucket");
const ONLY_BUCKET = bucketArgIdx !== -1 ? process.argv[bucketArgIdx + 1] : null;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AWS_REGION = process.env.AWS_REGION;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

// Buckets to migrate. Auto-discovered if listBuckets() works; this is the fallback.
const KNOWN_BUCKETS = ["documents", "private-documents", "nbfc-documents", "call-recordings"];

function die(msg) {
  console.error(`\n  ERROR: ${msg}\n`);
  process.exit(1);
}

if (!SUPABASE_URL || !SERVICE_KEY) die("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
if (!AWS_REGION) die("Missing AWS_REGION in .env.local");
if (!AWS_S3_BUCKET) die("Missing AWS_S3_BUCKET in .env.local (e.g. itarang-crm-storage)");
if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY)
  die("Missing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in .env.local");

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
});

const PAGE = 1000;

// Recursively yield every file path inside a Supabase bucket. Supabase's list()
// returns folders as entries with id === null; files have an id + metadata.
async function* walk(bucket, prefix = "") {
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
    if (error) die(`list failed for ${bucket}/${prefix}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const entry of data) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null && entry.metadata === null) {
        yield* walk(bucket, full); // folder
      } else {
        yield { path: full, size: entry.metadata?.size ?? null, mime: entry.metadata?.mimetype };
      }
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }
}

async function existsInS3(key, size) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key }));
    if (size == null) return true; // present; can't compare size
    return head.ContentLength === size; // same size = already copied
  } catch {
    return false;
  }
}

async function migrateBucket(bucket) {
  console.log(`\n=== Bucket: ${bucket} ===`);
  let copied = 0, skipped = 0, failed = 0, bytes = 0;
  for await (const file of walk(bucket)) {
    const key = `${bucket}/${file.path}`;
    if (await existsInS3(key, file.size)) {
      skipped++;
      continue;
    }
    if (DRY_RUN) {
      console.log(`  would copy  ${key}`);
      copied++;
      continue;
    }
    const { data, error } = await supabase.storage.from(bucket).download(file.path);
    if (error || !data) {
      console.error(`  FAIL download ${key}: ${error?.message || "no data"}`);
      failed++;
      continue;
    }
    const buf = Buffer.from(await data.arrayBuffer());
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: AWS_S3_BUCKET,
          Key: key,
          Body: buf,
          ContentType: file.mime || "application/octet-stream",
        }),
      );
      copied++;
      bytes += buf.length;
      if (copied % 25 === 0) console.log(`  ...${copied} copied`);
    } catch (e) {
      console.error(`  FAIL upload ${key}: ${e.message}`);
      failed++;
    }
  }
  console.log(
    `  done: ${copied} copied, ${skipped} skipped, ${failed} failed` +
      (bytes ? ` (${(bytes / 1024 / 1024).toFixed(1)} MB)` : ""),
  );
  return { bucket, copied, skipped, failed };
}

async function main() {
  console.log(
    `Supabase ${SUPABASE_URL}  ->  s3://${AWS_S3_BUCKET} (${AWS_REGION})${DRY_RUN ? "  [DRY RUN]" : ""}`,
  );

  let buckets = ONLY_BUCKET ? [ONLY_BUCKET] : null;
  if (!buckets) {
    const { data, error } = await supabase.storage.listBuckets();
    if (error || !data) {
      console.warn(`listBuckets failed (${error?.message}); using known list`);
      buckets = KNOWN_BUCKETS;
    } else {
      buckets = data.map((b) => b.name);
    }
  }
  console.log(`Buckets: ${buckets.join(", ")}`);

  const results = [];
  for (const b of buckets) results.push(await migrateBucket(b));

  console.log("\n===== SUMMARY =====");
  for (const r of results)
    console.log(`  ${r.bucket}: ${r.copied} copied, ${r.skipped} skipped, ${r.failed} failed`);
  const totalFailed = results.reduce((n, r) => n + r.failed, 0);
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((e) => die(e.stack || e.message));
