import type { Page, TestInfo } from '@playwright/test';
import { isDestructive } from './destructive-buttons';

/**
 * Click every visible interactive element on a page and report what happened.
 * Designed for the prod button-coverage sweep: we want to know which buttons
 * navigate, which throw, which 5xx, and which trigger console errors —
 * without having to author a per-page POM.
 *
 * Strategy:
 *   - Discover candidates via `button:visible, [role="button"]:visible, a[href]:visible`.
 *   - Skip the destructive set (Approve, Send SMS, Razorpay, …) and external
 *     hrefs / target=_blank links.
 *   - Re-goto the original URL between every click. Cheaper than trying to
 *     reason about SPA state, and idempotent.
 *   - Cap each click + post-click settle at 5s.
 *   - Error capture via page listeners attached before the first click.
 */

export type SweepResult = {
  url: string;
  tag: string;
  totalDiscovered: number;
  clicked: { name: string; postClickUrl: string }[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; error: string }[];
  consoleErrors: string[];
  pageErrors: string[];
  networkErrors: { url: string; status: number }[];
};

export type SweepOptions = {
  /** URL to sweep, relative to baseURL or absolute. */
  url: string;
  /** Short label for the report (e.g. "dealer-onboarding"). */
  tag: string;
  /** Hard limit on buttons clicked — protects against infinite-card lists. */
  maxClicks?: number;
  /**
   * Extra label-skip patterns specific to one page. Merged with the
   * destructive-buttons skiplist.
   */
  extraSkipPatterns?: RegExp[];
};

export async function sweepPage(
  page: Page,
  testInfo: TestInfo,
  opts: SweepOptions,
): Promise<SweepResult> {
  const { url, tag } = opts;
  const maxClicks = opts.maxClicks ?? 50;
  const extraSkip = opts.extraSkipPatterns ?? [];

  const result: SweepResult = {
    url,
    tag,
    totalDiscovered: 0,
    clicked: [],
    skipped: [],
    failed: [],
    consoleErrors: [],
    pageErrors: [],
    networkErrors: [],
  };

  // Listeners are scoped to this sweep — attach now, detach in finally.
  const onConsole = (msg: any) => {
    if (msg.type() === 'error') result.consoleErrors.push(truncate(msg.text(), 240));
  };
  const onPageError = (err: Error) => {
    result.pageErrors.push(truncate(err.message, 240));
  };
  const baseHost = new URL(page.url() || (process.env.E2E_BASE_URL ?? 'http://localhost')).host;
  const onResponse = (res: any) => {
    if (res.status() >= 400) {
      const u = res.url();
      try {
        if (new URL(u).host === baseHost) {
          result.networkErrors.push({ url: truncate(u, 200), status: res.status() });
        }
      } catch {
        // ignore unparseable
      }
    }
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});

    const namesToClick = await collectClickableNames(page, extraSkip, result);
    result.totalDiscovered = namesToClick.length + result.skipped.length;

    let clickCount = 0;
    for (const name of namesToClick) {
      if (clickCount >= maxClicks) {
        result.skipped.push({ name, reason: 'max-clicks-cap' });
        continue;
      }

      try {
        // Re-locate every iteration — the previous click may have mutated DOM.
        const locator = page
          .getByRole('button', { name })
          .or(page.getByRole('link', { name }))
          .first();
        const visible = await locator.isVisible().catch(() => false);
        if (!visible) {
          result.skipped.push({ name, reason: 'not-visible-after-replay' });
          continue;
        }

        await locator.click({ timeout: 5_000, trial: false });
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
        result.clicked.push({ name, postClickUrl: page.url() });
        clickCount += 1;
      } catch (err) {
        result.failed.push({ name, error: truncate((err as Error).message, 240) });
      }

      // Reset to the canonical URL between clicks so SPAs don't drift.
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      } catch (err) {
        result.failed.push({
          name: `[reset after ${name}]`,
          error: truncate((err as Error).message, 240),
        });
      }
    }
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
  }

  await testInfo.attach('sweep-result', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });

  return result;
}

async function collectClickableNames(
  page: Page,
  extraSkip: RegExp[],
  result: SweepResult,
): Promise<string[]> {
  // Use evaluate to collect labels in one trip. We deduplicate by accessible
  // name so the same button isn't clicked twice if it's mounted in two slots.
  const elements = await page.$$('button, [role="button"], a[href]');
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const el of elements) {
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;

    const name = await accessibleName(el);
    if (!name) {
      result.skipped.push({ name: '(unnamed)', reason: 'no-accessible-name' });
      continue;
    }

    if (await el.getAttribute('data-e2e-skip')) {
      result.skipped.push({ name, reason: 'data-e2e-skip' });
      continue;
    }

    const target = await el.getAttribute('target');
    if (target === '_blank') {
      result.skipped.push({ name, reason: 'target-blank' });
      continue;
    }

    const href = await el.getAttribute('href');
    if (href && /^https?:\/\//i.test(href)) {
      try {
        const baseHost = new URL(page.url()).host;
        if (new URL(href).host !== baseHost) {
          result.skipped.push({ name, reason: 'external-href' });
          continue;
        }
      } catch {
        // unparseable href — be safe and skip
        result.skipped.push({ name, reason: 'unparseable-href' });
        continue;
      }
    }

    if (isDestructive(name)) {
      result.skipped.push({ name, reason: 'destructive' });
      continue;
    }

    if (extraSkip.some((rx) => rx.test(name))) {
      result.skipped.push({ name, reason: 'extra-skip' });
      continue;
    }

    if (seen.has(name)) continue;
    seen.add(name);
    ordered.push(name);
  }

  return ordered;
}

async function accessibleName(el: any): Promise<string> {
  // Priority: aria-label > visible text > title > placeholder.
  const aria = (await el.getAttribute('aria-label')) ?? '';
  if (aria.trim()) return aria.trim();
  const text = ((await el.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text;
  const title = (await el.getAttribute('title')) ?? '';
  if (title.trim()) return title.trim();
  return '';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
