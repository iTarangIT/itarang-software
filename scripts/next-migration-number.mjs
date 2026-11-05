// ID 226 — one number counter for drizzle/E-NNN migrations.
//
//   npm run migration:next
//
// Several people and agents write migrations on their own branches, and two of
// them have picked the same E- number more than once (E-237/E-238, E-371 on
// 5 Nov). Run this BEFORE naming a new migration file, and again before
// pushing. It fetches origin, then reads every E- number it can see:
//   - drizzle/E-*.sql on origin/main and on every remote branch;
//   - drizzle/E-*.sql in this working tree (not yet pushed);
//   - every "E-NNN" row in drizzle/MIGRATION_CHECKLIST.md.
// and prints the highest, where it lives, and the next free number. Read-only.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const num = (name) => {
  const m = /^E-(\d+)[_-]/.exec(name.replace(/^.*\//, ""));
  return m ? Number(m[1]) : null;
};

try {
  git("fetch", "--quiet", "origin");
} catch {
  console.warn("(could not fetch origin; using the remote branches as last fetched)");
}

/** number → set of places it was seen */
const seen = new Map();
const add = (n, where) => {
  if (n == null) return;
  if (!seen.has(n)) seen.set(n, new Set());
  seen.get(n).add(where);
};

const branches = git("for-each-ref", "--format=%(refname:short)", "refs/remotes/origin")
  .split("\n")
  .map((s) => s.trim())
  .filter((b) => b && b !== "origin/HEAD" && b !== "origin");
for (const b of branches) {
  let files = "";
  try {
    files = git("ls-tree", "--name-only", `${b}`, "drizzle/");
  } catch {
    continue;
  }
  for (const f of files.split("\n")) add(num(f), b);
}

if (existsSync("drizzle")) for (const f of readdirSync("drizzle")) add(num(f), "this working tree");

if (existsSync("drizzle/MIGRATION_CHECKLIST.md")) {
  for (const m of readFileSync("drizzle/MIGRATION_CHECKLIST.md", "utf8").matchAll(/^\|\s*E-(\d+)[_-]/gm)) {
    add(Number(m[1]), "MIGRATION_CHECKLIST.md");
  }
}

const numbers = [...seen.keys()].sort((a, b) => a - b);
if (!numbers.length) {
  console.log("No E- migrations found.");
  process.exit(0);
}
const top = numbers.slice(-5);
console.log("Highest E- numbers seen:");
for (const n of top) console.log(`  E-${n}  ${[...seen.get(n)].sort().join(", ")}`);
const next = numbers[numbers.length - 1] + 1;
console.log(`\nNext free number: E-${next}`);
console.log("Re-run this just before pushing: another branch may take it first.");
