// RUN THIS ON THE PRODUCTION VPS (where public/nbfc-uploads/ lives and the prod
// .env has the AWS creds). It recovers the 17 NBFC agreement/audit PDFs that are
// referenced by database-2 but were never in the Supabase bucket — by reading
// them from the local disk fallback and uploading to s3://itarang-crm-production.
//
// It NEVER deletes anything. Reports which of the 17 were found on disk vs not.
// Any not on disk must be re-fetched from Digio instead (separate step).
//
// Usage (from the app root on the VPS, e.g. /var/www/itarang or wherever PM2 runs it):
//   node scripts/copy-missing-nbfc-from-disk-to-s3.mjs            # dry-run: report disk presence
//   node scripts/copy-missing-nbfc-from-disk-to-s3.mjs --upload   # upload found files to S3
//
// If public/nbfc-uploads is not under the cwd, set:  NBFC_UPLOADS_DIR=/abs/path/public/nbfc-uploads

import { readFileSync, existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

// The 17 S3 keys (format: nbfc-documents/<key>) that were missing from Supabase.
const MISSING = [
  "nbfc-documents/agreements/4de51b0d-7298-43ab-83c5-d645782b14a7/signed-agreement.pdf",
  "nbfc-documents/agreements/b4846be7-deb9-4830-bffb-a47624f4f3db/signed-agreement.pdf",
  "nbfc-documents/agreements/fc17cc32-5d4d-4567-be3e-0d295afbfd73/signed-agreement.pdf",
  "nbfc-documents/agreements/92a9904b-9dcf-4b10-8d61-b8b3310da6d8/signed-agreement.pdf",
  "nbfc-documents/agreements/e1737625-9e4d-42ad-ab8f-259fdba7bf66/signed-agreement.pdf",
  "nbfc-documents/agreements/36b37aa9-3263-41c2-a4d5-cfa85379d1ac/signed-agreement.pdf",
  "nbfc-documents/agreements/2b3ae8fb-a2ec-4a60-b4ce-9f0561004f27/signed-agreement.pdf",
  "nbfc-documents/agreements/acfc1128-b766-4e4a-9965-e0e450ef4ce7/signed-agreement.pdf",
  "nbfc-documents/agreements/4de51b0d-7298-43ab-83c5-d645782b14a7/audit-trail.pdf",
  "nbfc-documents/agreements/b4846be7-deb9-4830-bffb-a47624f4f3db/audit-trail.pdf",
  "nbfc-documents/agreements/fc17cc32-5d4d-4567-be3e-0d295afbfd73/audit-trail.pdf",
  "nbfc-documents/agreements/92a9904b-9dcf-4b10-8d61-b8b3310da6d8/audit-trail.pdf",
  "nbfc-documents/agreements/e1737625-9e4d-42ad-ab8f-259fdba7bf66/audit-trail.pdf",
  "nbfc-documents/agreements/36b37aa9-3263-41c2-a4d5-cfa85379d1ac/audit-trail.pdf",
  "nbfc-documents/agreements/acfc1128-b766-4e4a-9965-e0e450ef4ce7/audit-trail.pdf",
  "nbfc-documents/agreements/2b3ae8fb-a2ec-4a60-b4ce-9f0561004f27/audit-trail.pdf",
  "nbfc-documents/agreements/1d2137ab-62ee-4da4-95da-7b30622e10fb/audit-trail.pdf",
];

const UPLOAD = process.argv.includes("--upload");
const uploadsDir = process.env.NBFC_UPLOADS_DIR || join(process.cwd(), "public", "nbfc-uploads");
const AWS_REGION = process.env.AWS_REGION;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || "itarang-crm-production";
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

const s3 = (AWS_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY)
  ? new S3Client({ region: AWS_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } })
  : null;

async function inS3(key) {
  if (!s3) return false;
  try { await s3.send(new HeadObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key })); return true; } catch { return false; }
}

async function main() {
  console.log(`Looking under: ${uploadsDir}`);
  console.log(`Target bucket: s3://${AWS_S3_BUCKET} (${AWS_REGION || "no region set"})${UPLOAD ? "" : "  [dry-run]"}\n`);
  const onDisk = [], notOnDisk = [];
  for (const s3Key of MISSING) {
    const sub = s3Key.replace(/^nbfc-documents\//, ""); // disk path is relative to public/nbfc-uploads
    const abs = join(uploadsDir, sub);
    if (existsSync(abs) && statSync(abs).isFile()) onDisk.push({ s3Key, abs });
    else notOnDisk.push(s3Key);
  }
  console.log(`On disk: ${onDisk.length} / ${MISSING.length}`);
  for (const f of onDisk) console.log(`  found  ${f.s3Key}`);
  if (notOnDisk.length) {
    console.log(`\nNOT on disk: ${notOnDisk.length} (these must be re-fetched from Digio):`);
    for (const k of notOnDisk) console.log(`  missing ${k}`);
  }

  if (!UPLOAD) { console.log("\n(dry-run — re-run with --upload to push the found files to S3.)"); return; }
  if (!s3) { console.error("\nCannot upload: AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set in env."); process.exit(1); }

  let uploaded = 0;
  for (const f of onDisk) {
    if (await inS3(f.s3Key)) { console.log(`  skip (exists)  ${f.s3Key}`); continue; }
    const buf = await fs.readFile(f.abs);
    await s3.send(new PutObjectCommand({ Bucket: AWS_S3_BUCKET, Key: f.s3Key, Body: buf, ContentType: "application/pdf" }));
    uploaded++;
    console.log(`  uploaded  ${f.s3Key}`);
  }
  console.log(`\nUploaded ${uploaded} file(s). Still need Digio re-fetch for ${notOnDisk.length}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
