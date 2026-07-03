/**
 * Headless-browser page-load audit for the iTarang CRM.
 *
 * Sweeps every page in pages.json per role, measures load metrics (TTFB, FCP,
 * LCP, CLS, network-idle, transfer/JS bytes, slowest API calls, errors) and
 * writes perf-reports/<timestamp>/report.{json,md}.
 *
 *   npm run perf:audit                       # sandbox, roles ceo,dealer,sales_head
 *   PERF_BASE_URL=http://localhost:3000 npm run perf:audit
 *   PERF_PAGE_FILTER='^/(login|ceo)' PERF_ROLES=ceo npm run perf:audit
 *
 * Env (also read from .env.test.local, CLI wins):
 *   PERF_BASE_URL         target origin (default E2E_BASE_URL ?? sandbox)
 *   PERF_ROLES            comma list of ceo,dealer,sales_head,public (default all four)
 *   PERF_RUNS_PER_PAGE    measured runs per page, medians reported (default 2)
 *   PERF_PAGE_FILTER      regex over page URLs to subset the sweep
 *   PERF_INCLUDE_DYNAMIC  "0" to skip :id pages (default on)
 *   PERF_NAV_TIMEOUT_MS   per-navigation timeout (default 30000)
 *   PERF_BLOCK_THIRD_PARTY "0" to disable the maps/analytics noise blocker
 *   E2E_TEST_PASSWORD, E2E_CEO_EMAIL, E2E_CEO_PASSWORD   login credentials
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "@playwright/test";
import dotenv from "dotenv";
import { ensureStorageState } from "./auth";
import { installNoiseBlocker, installPerfObservers, measurePage, medianSample } from "./metrics";
import { emptyReport, writeReport } from "./report";
import type { AuditRole, PageEntry, PageResult, RunSample } from "./types";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test.local"), override: false });

const BASE_URL = (
  process.env.PERF_BASE_URL ??
  process.env.E2E_BASE_URL ??
  "https://sandbox.itarang.com"
).replace(/\/$/, "");
const ROLES = (process.env.PERF_ROLES ?? "ceo,dealer,sales_head,public")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean) as AuditRole[];
const RUNS_PER_PAGE = Math.max(1, Number(process.env.PERF_RUNS_PER_PAGE ?? 2));
const PAGE_FILTER = process.env.PERF_PAGE_FILTER
  ? new RegExp(process.env.PERF_PAGE_FILTER)
  : null;
const INCLUDE_DYNAMIC = process.env.PERF_INCLUDE_DYNAMIC !== "0";
const NAV_TIMEOUT_MS = Number(process.env.PERF_NAV_TIMEOUT_MS ?? 30_000);

function loadInventory(): PageEntry[] {
  const file = path.join(__dirname, "pages.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as PageEntry[];
}

/** "/leads/:id" → /^\/leads\/([^/?#]+)$/ */
function patternToRegex(url: string): RegExp {
  const escaped = url
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/?#]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${escaped}/?$`);
}

function getByJsonPath(body: unknown, jsonPath: string): unknown {
  let cur: unknown = body;
  for (const seg of jsonPath.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

async function resolveDynamicUrl(
  entry: PageEntry,
  harvested: Set<string>,
  context: BrowserContext,
): Promise<{ url: string } | { skip: string }> {
  const regex = patternToRegex(entry.url);
  for (const pathname of harvested) {
    if (regex.test(pathname)) return { url: pathname };
  }
  if (entry.idDiscovery) {
    try {
      const res = await context.request.get(`${BASE_URL}${entry.idDiscovery.api}`);
      if (res.ok()) {
        const id = getByJsonPath(await res.json(), entry.idDiscovery.jsonPath);
        if (id !== undefined && id !== null && `${id}`.length > 0) {
          // Single-:param routes only; multi-param routes need link harvesting.
          return { url: entry.url.replace(/:[^/]+/, String(id)) };
        }
      }
      return { skip: `idDiscovery ${entry.idDiscovery.api} returned no id` };
    } catch (err) {
      return { skip: `idDiscovery failed: ${(err as Error).message.slice(0, 120)}` };
    }
  }
  return { skip: "no-id-discovered (not linked from any swept page)" };
}

async function measureWithRetry(
  context: BrowserContext,
  absoluteUrl: string,
  harvestedHrefs: Set<string>,
): Promise<{ samples: RunSample[] } | { error: string }> {
  const samples: RunSample[] = [];
  for (let run = 0; run < RUNS_PER_PAGE; run++) {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        samples.push(
          await measurePage(context, absoluteUrl, {
            navTimeoutMs: NAV_TIMEOUT_MS,
            // Harvest links on the first run only — later runs are identical.
            harvestedHrefs: run === 0 ? harvestedHrefs : undefined,
          }),
        );
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    if (lastErr) {
      if (samples.length > 0) break; // keep what we have
      return { error: lastErr.message.slice(0, 300) };
    }
  }
  return { samples };
}

async function main() {
  const commit = (() => {
    try {
      return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  })();

  const inventory = loadInventory().filter((e) => !PAGE_FILTER || PAGE_FILTER.test(e.url));
  const report = emptyReport(BASE_URL, commit, RUNS_PER_PAGE, ROLES);
  const outDir = path.resolve(
    __dirname,
    "../../perf-reports",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );

  console.log(
    `[perf-audit] ${inventory.length} inventory pages, roles=[${ROLES.join(",")}], ` +
      `${RUNS_PER_PAGE} run(s)/page → ${BASE_URL}`,
  );

  // PERF_CHROMIUM_PATH: escape hatch for environments whose pre-installed
  // Chromium doesn't match the pinned Playwright browser build (e.g. remote
  // containers exposing a single binary at /opt/pw-browsers/chromium).
  const executablePath = process.env.PERF_CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const role of ROLES) {
      const pages = inventory.filter((e) => e.roles.includes(role));
      if (pages.length === 0) continue;

      let storageState: string | undefined;
      try {
        storageState = await ensureStorageState(browser, role, BASE_URL);
      } catch (err) {
        console.error(`[perf-audit] skipping role ${role}: ${(err as Error).message}`);
        for (const e of pages) {
          report.skipped.push({ url: e.url, role, reason: "login failed for role" });
        }
        continue;
      }

      const context = await browser.newContext({ storageState });
      context.setDefaultTimeout(NAV_TIMEOUT_MS);
      await installPerfObservers(context);
      if (process.env.PERF_BLOCK_THIRD_PARTY !== "0") await installNoiseBlocker(context);

      const harvestedHrefs = new Set<string>();
      const staticPages = pages.filter((e) => !e.dynamic);
      const dynamicPages = pages.filter((e) => e.dynamic);

      // Static pages first — their links seed dynamic-:id resolution.
      const queue: { entry: PageEntry; resolvedUrl: string }[] = [];
      for (const entry of staticPages) {
        if (entry.skip) {
          report.skipped.push({ url: entry.url, role, reason: entry.skip });
          continue;
        }
        queue.push({ entry, resolvedUrl: entry.url });
      }

      let done = 0;
      const total = queue.length + (INCLUDE_DYNAMIC ? dynamicPages.length : 0);
      const runOne = async (entry: PageEntry, resolvedUrl: string) => {
        done += 1;
        process.stdout.write(`[perf-audit] (${role} ${done}/${total}) ${resolvedUrl} ... `);
        const outcome = await measureWithRetry(context, `${BASE_URL}${resolvedUrl}`, harvestedHrefs);
        if ("error" in outcome) {
          console.log(`ERROR ${outcome.error.split("\n")[0]}`);
          report.results.push({
            url: entry.url,
            resolvedUrl,
            role,
            status: "error",
            error: outcome.error,
            median: null,
            samples: [],
          });
          return;
        }
        const median = medianSample(outcome.samples);
        console.log(
          `lcp=${median?.lcpMs?.toFixed(0) ?? "–"}ms idle=${median?.networkIdleMs.toFixed(0)}ms`,
        );
        report.results.push({
          url: entry.url,
          resolvedUrl,
          role,
          status: "ok",
          median,
          samples: outcome.samples,
        } as PageResult);
      };

      for (const { entry, resolvedUrl } of queue) await runOne(entry, resolvedUrl);

      if (INCLUDE_DYNAMIC) {
        for (const entry of dynamicPages) {
          if (entry.skip) {
            report.skipped.push({ url: entry.url, role, reason: entry.skip });
            done += 1;
            continue;
          }
          const resolved = await resolveDynamicUrl(entry, harvestedHrefs, context);
          if ("skip" in resolved) {
            report.skipped.push({ url: entry.url, role, reason: resolved.skip });
            done += 1;
            continue;
          }
          await runOne(entry, resolved.url);
        }
      }

      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }

  report.finishedAt = new Date().toISOString();
  const { json, md } = writeReport(report, outDir);
  console.log(`\n[perf-audit] report written:\n  ${json}\n  ${md}`);
}

main().catch((err) => {
  console.error("[perf-audit] fatal:", err);
  process.exitCode = 1;
});
