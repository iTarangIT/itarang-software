// Remove objects from s3://itarang-crm-production that are NOT in the production
// manifest (scripts/out/prod-doc-manifest.json) — i.e. the orphaned/test files
// the earlier broad copy left behind, so the bucket holds ONLY production docs.
//
// SAFE: the source bytes still exist in Supabase (never deleted there), so a
// pruned object is recoverable. Default is LIST-ONLY; pass --delete to execute.
//
// Run:
//   node scripts/prune-s3-to-manifest.mjs            # dry-run: list what would be deleted
//   node scripts/prune-s3-to-manifest.mjs --delete   # actually delete non-manifest keys

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";

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

const DELETE = process.argv.includes("--delete");
const AWS_REGION = process.env.AWS_REGION;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

function die(m) { console.error(`\n  ERROR: ${m}\n`); process.exit(1); }
if (AWS_S3_BUCKET !== "itarang-crm-production")
  die(`Refusing: AWS_S3_BUCKET is "${AWS_S3_BUCKET}", expected "itarang-crm-production".`);
if (!AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) die("Missing AWS creds/region");

const manifest = JSON.parse(readFileSync(join(ROOT, "scripts", "out", "prod-doc-manifest.json"), "utf8"));
const keep = new Set(manifest.map((e) => `${e.bucket}/${e.key}`));

const s3 = new S3Client({ region: AWS_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });

async function main() {
  const toDelete = [];
  let total = 0;
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: AWS_S3_BUCKET, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of r.Contents || []) {
      total++;
      if (!keep.has(o.Key)) toDelete.push(o.Key);
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);

  console.log(`Bucket has ${total} objects. Manifest keeps ${keep.size}. Non-manifest (prune candidates): ${toDelete.length}.`);
  const byPrefix = {};
  for (const k of toDelete) { const p = k.split("/")[0]; byPrefix[p] = (byPrefix[p] || 0) + 1; }
  for (const [p, n] of Object.entries(byPrefix).sort()) console.log(`  ${p}/: ${n}`);

  const p = join(ROOT, "scripts", "out", "prod-s3-prune-candidates.json");
  writeFileSync(p, JSON.stringify(toDelete, null, 2));
  console.log(`\nFull list: ${p}`);

  if (!DELETE) { console.log("\n(dry-run — nothing deleted. Re-run with --delete to remove these.)"); return; }
  if (!toDelete.length) { console.log("\nNothing to prune."); return; }

  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += 1000) {
    const batch = toDelete.slice(i, i + 1000).map((Key) => ({ Key }));
    const r = await s3.send(new DeleteObjectsCommand({ Bucket: AWS_S3_BUCKET, Delete: { Objects: batch, Quiet: true } }));
    deleted += batch.length - (r.Errors?.length || 0);
    if (r.Errors?.length) for (const e of r.Errors) console.log(`  FAIL delete ${e.Key}: ${e.Message}`);
  }
  console.log(`\nDeleted ${deleted}/${toDelete.length} non-manifest objects. Bucket now holds only production-referenced documents.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
