// ID 195 / live step L4: copy every file tracked under public/nbfc-uploads/ into the
// private S3 store at nbfc-documents/<same key>, so the /nbfc-uploads/<key> URLs in
// the DB keep resolving (via /api/nbfc-uploads) once the public folder is emptied.
//
// Never overwrites (an existing key is skipped) and never deletes. Dry run by default.
//
//   S3_CHECK_BUCKET=itarang-crm-storage node --env-file=.env.local scripts/copy-nbfc-public-to-s3.mjs
//   S3_CHECK_BUCKET=itarang-crm-storage node --env-file=.env.local scripts/copy-nbfc-public-to-s3.mjs --upload
//
// Check afterwards with scripts/verify-nbfc-public-in-s3.mjs.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const upload = process.argv.includes("--upload");
const bucket = process.env.S3_CHECK_BUCKET || process.env.AWS_S3_BUCKET;
const region = process.env.AWS_REGION;
if (!bucket || !region) throw new Error("AWS_S3_BUCKET / AWS_REGION not set");

const s3 = new S3Client({
  region,
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
      : undefined,
});

const CONTENT_TYPES = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

const PREFIX = "nbfc-documents/";
const files = execFileSync("git", ["ls-files", "public/nbfc-uploads"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

let present = 0;
let copied = 0;
const toCopy = [];
for (const f of files) {
  const key = PREFIX + f.slice("public/nbfc-uploads/".length);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    present++;
    continue;
  } catch (err) {
    // 403 = this key cannot read the bucket; stop rather than guess.
    if (err.$metadata?.httpStatusCode !== 404) throw err;
  }
  toCopy.push(key);
  if (!upload) continue;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: readFileSync(f),
      ContentType: CONTENT_TYPES[extname(f).toLowerCase()] ?? "application/octet-stream",
    }),
  );
  copied++;
}

console.log(`bucket ${bucket} — ${upload ? "UPLOAD" : "dry run"}`);
console.log(`  tracked files      : ${files.length}`);
console.log(`  already in S3      : ${present}`);
console.log(`  ${upload ? "copied" : "would copy"}         : ${upload ? copied : toCopy.length}`);
