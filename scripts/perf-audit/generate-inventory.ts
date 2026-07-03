/**
 * Regenerates scripts/perf-audit/pages.json by scanning src/app/(...)/page.tsx.
 *
 * Route groups "(dashboard)"/"(auth)" are stripped, "[param]" becomes ":param".
 * Roles are derived from the same prefix tables src/middleware.ts uses, then
 * merged with the existing pages.json so hand annotations (idDiscovery, skip,
 * extra roles) survive regeneration.
 *
 * Usage: npm run perf:inventory
 */
import fs from "node:fs";
import path from "node:path";
import type { AuditRole, PageEntry } from "./types";

const ROOT = path.resolve(__dirname, "../..");
const APP_DIR = path.join(ROOT, "src", "app");
const OUT_FILE = path.join(__dirname, "pages.json");

/** Prefix → roles that should measure it. First match wins; "/": fallback. */
const ROLE_PREFIXES: [string, AuditRole[]][] = [
  ["/login", ["public"]],
  ["/logout", []], // navigating here kills the session mid-sweep — never measure
  ["/terms", ["public"]],
  ["/privacy", ["public"]],
  ["/dealer-onboarding", ["public"]],
  ["/change-password", ["ceo"]],
  ["/dealer-portal", ["dealer", "ceo"]],
  ["/sales-head", ["sales_head", "ceo"]],
  ["/leads", ["sales_head", "ceo"]],
  ["/admin/dealer-verification", ["sales_head", "ceo"]],
  ["/admin/kyc-review", ["sales_head", "ceo"]],
];

/** Signed-token public flows that cannot be fabricated from list pages. */
const TOKEN_SKIPS: [string, string][] = [
  ["/vkyc/", "signed-token flow"],
  ["/fi/", "signed-token flow"],
  ["/onboarding/correct/", "signed-token flow"],
  ["/coborrowerconsent/", "signed-token flow"],
  ["/upload-docs/", "signed-token flow"],
  ["/loop-test/", "internal test page"],
  ["/api/", "page.tsx under /api — not a navigable CRM page"],
];

function walkPages(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkPages(full, acc);
    else if (entry.name === "page.tsx" || entry.name === "page.ts") acc.push(full);
  }
  return acc;
}

function toUrl(pageFile: string): string {
  const rel = path.relative(APP_DIR, path.dirname(pageFile));
  const segments = rel
    .split(path.sep)
    // Next.js: "(group)" segments don't appear in the URL. Directory names on
    // disk are sometimes URL-encoded ("%5Bid%5D") — normalise those too.
    .map((s) => decodeURIComponent(s))
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
    .map((s) => s.replace(/^\[(?:\.\.\.)?(.+)\]$/, ":$1"));
  const url = "/" + segments.join("/");
  return url === "/" ? "/" : url.replace(/\/+$/, "");
}

function rolesFor(url: string): AuditRole[] {
  for (const [prefix, roles] of ROLE_PREFIXES) {
    if (url === prefix || url.startsWith(prefix + "/")) return roles;
  }
  return ["ceo"]; // CEO passes every middleware gate (src/middleware.ts:272)
}

function skipReason(url: string): string | undefined {
  for (const [prefix, reason] of TOKEN_SKIPS) {
    if (url.startsWith(prefix)) return reason;
  }
  return undefined;
}

function main() {
  const existing: PageEntry[] = fs.existsSync(OUT_FILE)
    ? JSON.parse(fs.readFileSync(OUT_FILE, "utf8"))
    : [];
  const existingByUrl = new Map(existing.map((e) => [e.url, e]));

  const seen = new Set<string>();
  const entries: PageEntry[] = walkPages(APP_DIR)
    .map((file) => {
      const url = toUrl(file);
      const prev = existingByUrl.get(url);
      const skip = prev?.skip ?? skipReason(url);
      const entry: PageEntry = {
        url,
        sourceFile: path.relative(ROOT, file),
        roles: prev?.roles ?? rolesFor(url),
        dynamic: url.includes(":"),
        idDiscovery: prev?.idDiscovery ?? null,
      };
      if (skip) entry.skip = skip;
      return entry;
    })
    // Two page.tsx files can map to one URL (e.g. src/app/page.tsx vs
    // src/app/(dashboard)/page.tsx) — keep the first, they render one route.
    .filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)))
    .sort((a, b) => a.url.localeCompare(b.url));

  fs.writeFileSync(OUT_FILE, JSON.stringify(entries, null, 2) + "\n");
  const skipped = entries.filter((e) => e.skip).length;
  console.log(
    `[perf:inventory] ${entries.length} pages written to ${path.relative(ROOT, OUT_FILE)} ` +
      `(${entries.filter((e) => e.dynamic).length} dynamic, ${skipped} skipped-by-design)`,
  );
}

main();
