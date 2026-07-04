/**
 * Per-page measurement for the perf-audit harness.
 *
 * Metrics come from three sources:
 *  - Navigation Timing / Paint Timing (TTFB, FCP, DCL, load)
 *  - buffered PerformanceObservers installed via addInitScript (LCP, CLS) —
 *    init-script because buffered entries can be dropped if observed post-load
 *  - a CDP Network session (transfer bytes, JS bytes, request count) — Resource
 *    Timing transferSize is 0 for cross-origin responses without TAO headers
 */
import type { BrowserContext, Page } from "@playwright/test";
import type { ApiCallTiming, RunSample } from "./types";

declare global {
  interface Window {
    __perfAudit?: { lcp: number | null; cls: number };
  }
}

/** Install buffered LCP/CLS observers on every page of the context. */
export async function installPerfObservers(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const state: { lcp: number | null; cls: number } = { lcp: null, cls: 0 };
    (window as Window).__perfAudit = state;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.lcp = entry.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
          if (!shift.hadRecentInput) state.cls += shift.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      // Non-Chromium engines: leave nulls, everything else still works.
    }
  });
}

/**
 * Abort third-party noise (maps/analytics) so network-idle is reachable and
 * comparable between runs. Mirrors tests/e2e/fixtures.ts `noiseBlocker`.
 */
export async function installNoiseBlocker(context: BrowserContext): Promise<void> {
  await context.route("**/maps.googleapis.com/**", (route) => route.abort());
  await context.route("**/supabase.co/analytics/**", (route) => route.abort());
  await context.route("**/n8n*/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
}

interface NavTimings {
  ttfbMs: number | null;
  fcpMs: number | null;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
}

async function readTimings(page: Page): Promise<NavTimings & { lcpMs: number | null; cls: number | null }> {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    const fcp = performance
      .getEntriesByType("paint")
      .find((e) => e.name === "first-contentful-paint");
    const audit = (window as Window).__perfAudit;
    return {
      ttfbMs: nav ? nav.responseStart - nav.requestStart : null,
      fcpMs: fcp ? fcp.startTime : null,
      domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
      loadEventMs: nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : null,
      lcpMs: audit?.lcp ?? null,
      cls: audit ? audit.cls : null,
    };
  });
}

/** Navigate to `url` in a fresh page of `context` and collect one RunSample. */
export async function measurePage(
  context: BrowserContext,
  url: string,
  opts: { navTimeoutMs: number; harvestedHrefs?: Set<string> },
): Promise<RunSample> {
  const page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    // Cold-ish HTTP cache each measured run so runs are comparable; cookies
    // (the Supabase session) live in the context and are untouched.
    await cdp.send("Network.clearBrowserCache");

    let transferBytes = 0;
    let jsBytes = 0;
    let requestCount = 0;
    const jsRequestIds = new Set<string>();
    cdp.on("Network.responseReceived", (e) => {
      requestCount += 1;
      if (e.type === "Script") jsRequestIds.add(e.requestId);
    });
    cdp.on("Network.loadingFinished", (e) => {
      transferBytes += e.encodedDataLength;
      if (jsRequestIds.has(e.requestId)) jsBytes += e.encodedDataLength;
    });

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const httpErrors: { url: string; status: number }[] = [];
    const apiCalls: ApiCallTiming[] = [];
    const origin = new URL(url).origin;

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 240));
    });
    page.on("pageerror", (err) => pageErrors.push(err.message.slice(0, 240)));
    page.on("response", (res) => {
      if (res.status() >= 400 && res.url().startsWith(origin)) {
        httpErrors.push({ url: res.url().slice(0, 200), status: res.status() });
      }
    });
    page.on("requestfinished", (req) => {
      const u = req.url();
      if (!u.startsWith(origin) || !new URL(u).pathname.startsWith("/api/")) return;
      const timing = req.timing();
      if (timing.responseEnd > 0) {
        apiCalls.push({
          url: new URL(u).pathname,
          durationMs: Math.round(timing.responseEnd),
          status: 0,
        });
      }
    });

    const navStart = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.navTimeoutMs });
    // Client-component pages hydrate via React Query after DCL — a page is only
    // "loaded" once its data requests settle.
    await page
      .waitForLoadState("networkidle", { timeout: opts.navTimeoutMs })
      .catch(() => {});
    const networkIdleMs = Date.now() - navStart;

    // Give buffered observers a beat to flush the final LCP candidate.
    await page.waitForTimeout(250);
    const timings = await readTimings(page);

    if (opts.harvestedHrefs) {
      const hrefs = await page
        .$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href))
        .catch(() => [] as string[]);
      for (const h of hrefs) {
        try {
          const parsed = new URL(h);
          if (parsed.origin === origin) opts.harvestedHrefs.add(parsed.pathname);
        } catch {
          /* ignore unparseable */
        }
      }
    }

    apiCalls.sort((a, b) => b.durationMs - a.durationMs);
    return {
      ...timings,
      networkIdleMs,
      transferBytes,
      jsBytes,
      requestCount,
      slowestApiCalls: apiCalls.slice(0, 5),
      consoleErrors,
      pageErrors,
      httpErrors,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function medianOf(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/** Field-wise median across samples; error lists come from the last sample. */
export function medianSample(samples: RunSample[]): RunSample | null {
  if (samples.length === 0) return null;
  const last = samples[samples.length - 1];
  return {
    ttfbMs: medianOf(samples.map((s) => s.ttfbMs)),
    fcpMs: medianOf(samples.map((s) => s.fcpMs)),
    lcpMs: medianOf(samples.map((s) => s.lcpMs)),
    cls: medianOf(samples.map((s) => s.cls)),
    domContentLoadedMs: medianOf(samples.map((s) => s.domContentLoadedMs)),
    loadEventMs: medianOf(samples.map((s) => s.loadEventMs)),
    networkIdleMs: medianOf(samples.map((s) => s.networkIdleMs)) ?? last.networkIdleMs,
    transferBytes: medianOf(samples.map((s) => s.transferBytes)) ?? last.transferBytes,
    jsBytes: medianOf(samples.map((s) => s.jsBytes)) ?? last.jsBytes,
    requestCount: medianOf(samples.map((s) => s.requestCount)) ?? last.requestCount,
    slowestApiCalls: last.slowestApiCalls,
    consoleErrors: last.consoleErrors,
    pageErrors: last.pageErrors,
    httpErrors: last.httpErrors,
  };
}
