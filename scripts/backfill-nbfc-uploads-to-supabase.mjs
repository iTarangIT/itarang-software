// One-time backfill: copy every file under public/nbfc-uploads/ into the
// private Supabase Storage bucket `nbfc-documents`, preserving the relative key
// (e.g. public/nbfc-uploads/fi/<id>/x.jpg → bucket key fi/<id>/x.jpg).
//
// Idempotent (upsert): safe to re-run. Run on the HOST where the real files
// live (the sandbox/prod VPS), since the local files are what's being migrated:
//   node scripts/backfill-nbfc-uploads-to-supabase.mjs
//   node scripts/backfill-nbfc-uploads-to-supabase.mjs --dry-run
//
// Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (read from
// .env.local / .env). Create the bucket first via drizzle/E-149_*.sql.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const UPLOADS_DIR = join(ROOT, "public", "nbfc-uploads");
const BUCKET = "nbfc-documents";
const DRY_RUN = process.argv.includes("--dry-run");

function loadDotEnv(path) {
  if (!existsSync(path)) return false;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
  return true;
}
loadDotEnv(join(ROOT, ".env.local")) || loadDotEnv(join(ROOT, ".env"));

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Aborting.");
  process.exit(1);
}
if (!existsSync(UPLOADS_DIR)) {
  console.log(`No ${UPLOADS_DIR} — nothing to backfill.`);
  process.exit(0);
}

const CONTENT_TYPES = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) yield* walk(abs);
    else if (st.isFile()) yield abs;
  }
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let ok = 0;
let failed = 0;
let total = 0;

console.log(`Backfilling ${UPLOADS_DIR} → bucket "${BUCKET}"${DRY_RUN ? " (DRY RUN)" : ""}\n`);

for (const absPath of walk(UPLOADS_DIR)) {
  total++;
  // Key = path relative to public/nbfc-uploads, forward-slashed.
  const key = relative(UPLOADS_DIR, absPath).split(sep).join("/");
  const ext = extname(absPath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

  if (DRY_RUN) {
    console.log(`would upload  ${key}  (${contentType})`);
    ok++;
    continue;
  }

  try {
    const body = readFileSync(absPath);
    const { error } = await supabase.storage.from(BUCKET).upload(key, body, { contentType, upsert: true });
    if (error) throw new Error(error.message);
    console.log(`uploaded      ${key}`);
    ok++;
  } catch (e) {
    console.error(`FAILED        ${key}: ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

console.log(`\nDone. ${ok}/${total} ${DRY_RUN ? "would upload" : "uploaded"}, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
