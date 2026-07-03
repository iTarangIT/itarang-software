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

  // Next 16 no longer writes app-build-manifest.json (and the build output's
  // route table has no size columns). Instead, each route's client-module
  // chunk list lives in .next/server/app/**/page_client-reference-manifest.js
  // as `globalThis.__RSC_MANIFEST["<route>"]={...json...}`.
  const buildManifestPath = path.join(NEXT_DIR, "build-manifest.json");
  const serverAppDir = path.join(NEXT_DIR, "server", "app");
  if (!fs.existsSync(buildManifestPath) || !fs.existsSync(serverAppDir)) {
    throw new Error(`[perf:bundle] ${NEXT_DIR} build artifacts missing — did the build succeed?`);
  }
  const buildManifest = JSON.parse(fs.readFileSync(buildManifestPath, "utf8")) as {
    rootMainFiles?: string[];
  };

  function findRouteManifests(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) findRouteManifests(full, acc);
      else if (entry.name === "page_client-reference-manifest.js") acc.push(full);
    }
    return acc;
  }

  function chunksForRoute(manifestFile: string): string[] {
    const src = fs.readFileSync(manifestFile, "utf8");
    const brace = src.indexOf("={");
    if (brace === -1) return [];
    const manifest = JSON.parse(src.slice(brace + 1)) as {
      clientModules?: Record<string, { chunks?: string[] }>;
    };
    const chunks = new Set<string>();
    for (const mod of Object.values(manifest.clientModules ?? {})) {
      // chunks arrays alternate [numericId, "static/chunks/….js", …]
      for (const c of mod.chunks ?? []) {
        if (c.includes("static/chunks/")) chunks.add(c);
      }
    }
    return [...chunks];
  }

  const cache = new Map<string, number>();
  const sharedChunks = new Set(buildManifest.rootMainFiles ?? []);
  const sharedBytes = sizeOfChunks([...sharedChunks], cache);

  const rows = findRouteManifests(serverAppDir)
    .map((manifestFile) => {
      const rel = path.relative(serverAppDir, path.dirname(manifestFile));
      const route =
        "/" +
        rel
          .split(path.sep)
          .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
          .join("/");
      const routeChunks = chunksForRoute(manifestFile).filter((c) => !sharedChunks.has(c));
      const routeBytes = sizeOfChunks(routeChunks, cache);
      return {
        route: route === "/" ? "/" : route.replace(/\/+$/, ""),
        routeKb: routeBytes / 1024,
        firstLoadKb: (routeBytes + sharedBytes) / 1024,
      };
    })
    .filter((r) => !r.route.startsWith("/_"))
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
