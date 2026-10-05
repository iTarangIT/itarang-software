/**
 * Route values must be awaited (tracker ID 127).
 *
 * Since Next 15 a route handler, page or layout under a `[segment]` folder gets
 * its `params` as a Promise. Reading `params.id` straight away works in dev and
 * is `undefined` on a production build — which is how 23 routes, the customer
 * document-upload link among them, shipped broken without anyone seeing it
 * locally. `ignoreBuildErrors` is on, so the compiler does not catch it either.
 *
 * This reads every such file as source and fails on:
 *   - `params` typed as a plain object instead of a Promise,
 *   - `params.x` / `ctx.params.x` / `= params` with no `await` (or `use(`),
 *   - `{ params: { id } }` destructured in the signature.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const APP_DIR = join(process.cwd(), "src", "app");
const SERVER_FILES = new Set(["route.ts", "route.tsx", "page.tsx", "layout.tsx", "default.tsx", "template.tsx"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SERVER_FILES.has(entry) && relative(APP_DIR, full).includes("[")) out.push(full);
  }
  return out;
}

/** Comments and string contents stripped, so prose about `params.id` is not a finding. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const files = walk(APP_DIR).map((file) => ({
  name: relative(APP_DIR, file).split(sep).join("/"),
  src: code(file),
}));

/** What is wrong with one file's use of `params`, as readable findings. */
export function syncParamsFindings(src: string): string[] {
  // A client component reads the URL with useParams(); that value is not a Promise.
  if (/\buseParams\s*\(/.test(src)) return [];
  // A local of the same name (URLSearchParams, a query's bind list) is not the route's params.
  if (/\b(?:const|let|var)\s+params\s*[=:]/.test(src)) return [];
  // Nor is a helper's own argument called `params`: `function send(params: { … })`.
  if (/[(,]\s*params\s*:/.test(src)) return [];

  const found: string[] = [];

  // Inside an object type — `{ params }: { params: { id: string } }`.
  for (const m of src.matchAll(/[{;]\s*params\??\s*:\s*\{\s*\w+\??\s*:/g)) {
    found.push(`typed as a plain object: "${m[0].replace(/^[{;]\s*/, "")}" — use params: Promise<{ … }>`);
  }
  for (const m of src.matchAll(/\bparams\s*:\s*\{\s*\w+\s*[,}]/g)) {
    found.push(`destructured in the signature: "${m[0]}"`);
  }
  for (const m of src.matchAll(/\bparams\.(\w+)/g)) {
    if (m[1] === "then") continue;
    const before = src.slice(Math.max(0, m.index! - 40), m.index!);
    if (/await\s+(?:\w+\.)?$/.test(before)) continue; // `await ctx.params.x` is still wrong, but not valid TS on a Promise
    found.push(`read without await: "params.${m[1]}"`);
  }
  for (const m of src.matchAll(/=\s*(?:\w+\.)?params\s*[;\n]/g)) {
    found.push(`read without await: "${m[0].trim()}"`);
  }
  return found;
}

describe("route values are awaited before they are read", () => {
  it("finds the files — a moved folder would make this vacuously pass", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("no route, page or layout reads params synchronously", () => {
    const offenders = files
      .map((f) => ({ name: f.name, found: syncParamsFindings(f.src) }))
      .filter((f) => f.found.length > 0)
      .map((f) => `${f.name}\n    ${f.found.join("\n    ")}`);
    expect(offenders, `\n${offenders.join("\n")}\n`).toEqual([]);
  });

  it("no page folder is named with an encoded bracket", () => {
    // `%5Bid%5D` is a literal path, not a dynamic segment: /deals/123 never reached it.
    const encoded: string[] = [];
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (!statSync(full).isDirectory()) continue;
        if (/%5B|%5D/i.test(entry)) encoded.push(relative(APP_DIR, full).split(sep).join("/"));
        scan(full);
      }
    };
    scan(APP_DIR);
    expect(encoded).toEqual([]);
  });

  it("the rule catches each shape, and passes the correct ones", () => {
    expect(syncParamsFindings("async (req, { params }: { params: { id: string } }) => { const a = params.id; }")).toHaveLength(2);
    expect(syncParamsFindings("async (req, { params }: any) => { const { id } = params;\n }")).toHaveLength(1);
    expect(syncParamsFindings("async (req, ctx: any) => { const id = ctx.params.id; }")).toHaveLength(1);
    expect(syncParamsFindings("function Page({ params: { id } }: any) {}")).toHaveLength(1);

    expect(syncParamsFindings("async (req, { params }: { params: Promise<{ id: string }> }) => { const { id } = await params; }")).toEqual([]);
    expect(syncParamsFindings("async (req, { params }: any) => { const id = (await params).id; }")).toEqual([]);
    expect(syncParamsFindings("async (req, ctx: any) => { const { id } = await ctx.params; }")).toEqual([]);
    expect(syncParamsFindings("function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); }")).toEqual([]);
    expect(syncParamsFindings("const params = useParams(); const id = params.id;")).toEqual([]);
  });
});
