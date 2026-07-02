/**
 * Offline per-route First-Load-JS report — no network or credentials needed.
 *
 * Runs `next build --webpack` with stub env (the Drizzle client only throws
 * when DATABASE_URL is unset and connects lazily, so a bogus URL is safe for
 * building), then sizes each app route's chunk list from the build manifests.
 *
 *   npm run perf:bundle                 # build + report
 *   PERF_SKIP_BUILD=1 npm run perf:bundle   # reuse existing .next
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const NEXT_DIR = path.join(ROOT, ".next");

const STUB_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://stub:stub@localhost:5432/stub",
  NEXT_PUBLIC_SUPABASE_URL: "https://stub.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "stub-anon-key",
  // Required at module load by src/lib/supabase/admin.ts during Next's
  // "collecting page data" phase — never actually called during a build.
  SUPABASE_SERVICE_ROLE_KEY: "stub-service-role-key",
};

function gzippedSize(file: string): number {
  // Report raw (uncompressed) chunk bytes — stable, fast, and what the build
  // manifests describe. Wire size is roughly 3-4x smaller with gzip/brotli.
  return fs.statSync(file).size;
}

function sizeOfChunks(chunks: string[], cache: Map<string, number>): number {
  let total = 0;
  for (const chunk of chunks) {
    if (!chunk.endsWith(".js")) continue;
    let size = cache.get(chunk);
    if (size === undefined) {
      const file = path.join(NEXT_DIR, chunk);
      size = fs.existsSync(file) ? gzippedSize(file) : 0;
      cache.set(chunk, size);
    }
    total += size;
  }
  return total;
}

function main() {
  if (process.env.PERF_SKIP_BUILD !== "1") {
    console.log("[perf:bundle] running next build --webpack with stub env ...");
    execSync("npx next build --webpack", {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...STUB_ENV, ...process.env },
    });
  }

  const appManifestPath = path.join(NEXT_DIR, "app-build-manifest.json");
  const buildManifestPath = path.join(NEXT_DIR, "build-manifest.json");
  if (!fs.existsSync(appManifestPath)) {
    throw new Error(`[perf:bundle] ${appManifestPath} not found — did the build succeed?`);
  }
  const appManifest = JSON.parse(fs.readFileSync(appManifestPath, "utf8")) as {
    pages: Record<string, string[]>;
  };
  const buildManifest = JSON.parse(fs.readFileSync(buildManifestPath, "utf8")) as {
    rootMainFiles?: string[];
  };

  const cache = new Map<string, number>();
  const sharedChunks = new Set(buildManifest.rootMainFiles ?? []);
  const sharedBytes = sizeOfChunks([...sharedChunks], cache);

  const rows = Object.entries(appManifest.pages)
    .filter(([route]) => route.endsWith("/page"))
    .map(([route, chunks]) => {
      const routeChunks = chunks.filter((c) => !sharedChunks.has(c));
      const routeBytes = sizeOfChunks(routeChunks, cache);
      return {
        route: route.replace(/\/page$/, "") || "/",
        routeKb: routeBytes / 1024,
        firstLoadKb: (routeBytes + sharedBytes) / 1024,
      };
    })
    .sort((a, b) => b.firstLoadKb - a.firstLoadKb);

  const commit = (() => {
    try {
      return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  })();

  const md: string[] = [
    `# Per-route First-Load JS — ${commit}`,
    "",
    `Shared chunks (all routes): **${(sharedBytes / 1024).toFixed(0)} KB** (uncompressed; wire size ≈ 3-4x smaller)`,
    "",
    "| Route | Route JS KB | First-Load JS KB |",
    "| --- | ---: | ---: |",
    ...rows.map(
      (r) => `| ${r.route} | ${r.routeKb.toFixed(0)} | ${r.firstLoadKb.toFixed(0)} |`,
    ),
    "",
  ];

  const outDir = path.join(ROOT, "perf-reports");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `bundle-${commit}.md`);
  fs.writeFileSync(outFile, md.join("\n"));

  console.log(`\n[perf:bundle] ${rows.length} routes, shared ${(sharedBytes / 1024).toFixed(0)} KB`);
  console.log("[perf:bundle] top 15 by route-specific JS:");
  for (const r of [...rows].sort((a, b) => b.routeKb - a.routeKb).slice(0, 15)) {
    console.log(`  ${r.routeKb.toFixed(0).padStart(6)} KB  ${r.route}`);
  }
  console.log(`\n[perf:bundle] written: ${outFile}`);
}

main();
