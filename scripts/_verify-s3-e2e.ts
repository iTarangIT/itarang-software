// E2E verification of the REAL converted storage code in S3 mode.
// Loads .env.local, then dynamically imports the actual app modules so
// isS3Backend reflects STORAGE_BACKEND=s3. Run: npx tsx scripts/_verify-s3-e2e.ts
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function load(p: string) {
  if (!existsSync(p)) return;
  for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = l.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i < 0) continue;
    const k = t.slice(0, i).trim(); let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
load(join(ROOT, ".env.local"));

const ok = (c: boolean, m: string) => console.log(`${c ? "PASS" : "FAIL"}  ${m}`);
let failures = 0;
const check = (c: boolean, m: string) => { ok(c, m); if (!c) failures++; };

async function main() {
const s3 = await import("../src/lib/storage/s3.ts");
const nbfc = await import("../src/lib/nbfc/nbfc-storage.ts");

check(s3.isS3Backend === true, `isS3Backend is true (STORAGE_BACKEND=${process.env.STORAGE_BACKEND})`);
check(s3.filesProxyPath("documents", "a/b c.pdf") === "/api/files/documents/a/b%20c.pdf",
  `filesProxyPath encodes segments -> ${s3.filesProxyPath("documents", "a/b c.pdf")}`);

// 1) Generic helper round-trip (documents bucket) via the REAL s3.ts.
const key = "__verify__/e2e-test.txt";
const body = Buffer.from("e2e " + process.env.AWS_S3_BUCKET);
await s3.putObject("documents", key, body, "text/plain");
const got = await s3.getObject("documents", key);
check(!!got && got.toString() === body.toString(), "putObject -> getObject round-trip matches");
const signed = await s3.signObject("documents", key, 60);
check(!!signed && /X-Amz-Signature/.test(signed!), "signObject returns a presigned URL");
await s3.removeObjects("documents", [key]);
const afterDel = await s3.getObject("documents", key);
check(afterDel === null, "removeObjects deletes the object");

// 2) nbfc-storage round-trip via the REAL converted helper.
const nk = "__verify__/nbfc-e2e.txt";
const r = await nbfc.putNbfcObject(nk, Buffer.from("nbfc e2e"), "text/plain");
check(r.url === `/nbfc-uploads/${nk}`, `putNbfcObject returns /nbfc-uploads path -> ${r.url}`);
const ng = await nbfc.getNbfcObject(nk);
check(!!ng && ng.toString() === "nbfc e2e", "getNbfcObject round-trip matches");
const ns = await nbfc.signNbfcObject(nk, 60);
check(!!ns && /X-Amz-Signature/.test(ns!), "signNbfcObject returns presigned URL");
await s3.removeObjects("nbfc-documents", [nk]);

// 3) Read back a REAL migrated production object (proves migrated data is served via the new code).
const manifest = JSON.parse(readFileSync(join(ROOT, "scripts/out/prod-doc-manifest.json"), "utf8"));
const real = manifest.find((e: { bucket: string; key: string }) => e.bucket === "dealer-documents");
if (real) {
  const buf = await s3.getObject(real.bucket, real.key);
  check(!!buf && buf.byteLength > 0, `read real migrated object ${real.bucket}/${real.key.slice(0, 48)}... (${buf?.byteLength ?? 0} bytes)`);
}

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
