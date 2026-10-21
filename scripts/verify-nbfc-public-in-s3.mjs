// ID 195 / live step L4: are the files tracked under public/nbfc-uploads/ also in
// the private S3 store (nbfc-documents/<key>)? READ-ONLY: lists the bucket, never
// writes or deletes.
//
//   node --env-file=.env.local scripts/verify-nbfc-public-in-s3.mjs
//   S3_CHECK_BUCKET=itarang-crm-production node --env-file=.env.local scripts/verify-nbfc-public-in-s3.mjs

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { S3Client, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";

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

const PREFIX = "nbfc-documents/";
const files = execFileSync("git", ["ls-files", "public/nbfc-uploads"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

// List the prefix; if the key may not list (prod app user has no s3:ListBucket),
// fall back to a HEAD per file.
const inS3 = new Map();
try {
  let token;
  do {
    const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }));
    for (const o of out.Contents ?? []) inS3.set(o.Key.slice(PREFIX.length), o.Size);
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
} catch (e) {
  if (e.name !== "AccessDenied") throw e;
  console.log("(no list permission — checking each file with HEAD)");
  for (const f of files) {
    const key = f.slice("public/nbfc-uploads/".length);
    try {
      const h = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: PREFIX + key }));
      inS3.set(key, h.ContentLength);
    } catch (err) {
      // 403 means this key cannot read the bucket at all — the answer is unknown,
      // not "missing", so stop rather than report a false result.
      if (err.$metadata?.httpStatusCode !== 404) throw err;
    }
  }
}

const same = [];
const sizeDiffers = [];
const missing = [];
for (const f of files) {
  const key = f.slice("public/nbfc-uploads/".length);
  const local = statSync(f).size;
  if (!inS3.has(key)) missing.push(key);
  else if (inS3.get(key) !== local) sizeDiffers.push(`${key}  (disk ${local} B, s3 ${inS3.get(key)} B)`);
  else same.push(key);
}

console.log(`bucket ${bucket}: ${inS3.size} objects under ${PREFIX}`);
console.log(`public/nbfc-uploads tracked files: ${files.length}`);
console.log(`  in S3, same size : ${same.length}`);
console.log(`  in S3, size diff : ${sizeDiffers.length}`);
console.log(`  NOT in S3        : ${missing.length}`);
if (sizeDiffers.length) console.log("\nSize differs:\n  " + sizeDiffers.join("\n  "));
if (missing.length) console.log("\nNot in S3:\n  " + missing.join("\n  "));
