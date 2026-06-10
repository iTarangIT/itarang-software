/**
 * Codemod: stop NBFC route handlers leaking raw error.message to the client.
 *
 * Surgical + reversible: only swaps the response *message* expression
 *   error: msg }, { status: statusFromError(msg) }
 *     →  error: clientError(msg) }, { status: statusFromError(msg) }
 * and adds the `clientError` import. Status codes and every other line are left
 * untouched, so the controlled 4xx responses keep their exact messages.
 *
 *   node scripts/harden-nbfc-errors.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Every NBFC-scoped route file that still leaks a raw error message, whether it
// derives the status via statusFromError(msg) or a computed `{ status }`.
// --untracked is REQUIRED: the E-16x routes (roles, notification-channels,
// wallet sub-routes, financing-offers, razorpay webhook) are new/untracked, and
// a plain `git grep` skips untracked files — which is exactly why they leaked.
const list = execSync(
  'git grep -l --untracked "error: msg }" -- ' +
    '"src/app/api/nbfc/**/route.ts" ' +
    '"src/app/api/admin/nbfc/**/route.ts" ' +
    '"src/app/api/sales-head/nbfc/**/route.ts" ' +
    '"src/app/api/payments/razorpay/**/route.ts"',
  { cwd: root, encoding: "utf8" },
)
  .split(/\r?\n/)
  .filter(Boolean);

const IMPORT_LINE = 'import { clientError } from "@/lib/nbfc/http-error";';
const changed = [];
const skipped = [];

for (const rel of list) {
  const abs = join(root, rel);
  let src = readFileSync(abs, "utf8");
  const before = src;

  // 1) swap the leaky message expression (all occurrences in the file).
  // Matches both the single-line form
  //   { ok: false, error: msg }, { status: statusFromError(msg) }
  // and the multi-line form where `{ status: … }` sits on the next line —
  // in both, the message object `… error: msg }` is a contiguous substring.
  src = src.replaceAll("error: msg }", "error: clientError(msg) }");

  if (src === before) {
    skipped.push(rel);
    continue;
  }

  // 2) ensure the import exists (insert after the next/server import line)
  if (!src.includes(IMPORT_LINE)) {
    const lines = src.split("\n");
    const idx = lines.findIndex((l) => l.includes('from "next/server"'));
    if (idx === -1) {
      // no anchor — restore and flag for manual handling
      skipped.push(rel + " (no next/server import anchor)");
      continue;
    }
    lines.splice(idx + 1, 0, IMPORT_LINE);
    src = lines.join("\n");
  }

  writeFileSync(abs, src, "utf8");
  changed.push(rel);
}

console.log(`changed ${changed.length} file(s):`);
for (const f of changed) console.log("  +", f);
console.log(`\nskipped ${skipped.length} file(s) (no exact match — review if any):`);
for (const f of skipped) console.log("  -", f);
