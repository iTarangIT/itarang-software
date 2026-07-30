/**
 * Authenticated browser sessions for the scanner.
 *
 * Logs each role in through the real /login page (same fill + force-click as
 * tests/e2e/global.setup.ts — the decorative rickshaw <img> sits above the
 * button and intercepts the hit-test) and captures its storageState. The engine
 * turns those into per-role API request contexts + browser contexts for probes.
 *
 * Roles + credentials come from the SAME env vars the e2e suite uses
 * (E2E_<ROLE>_EMAIL / E2E_<ROLE>_PASSWORD), with the long-standing seeded
 * sandbox users as fallback, so existing creds work without new setup. A role
 * with no resolvable password is skipped (not fatal).
 */
import { chromium, type Browser, type BrowserContext } from "@playwright/test";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface ScanRole {
  role: string;
  email?: string;
  password?: string;
}

function cred(role: string, field: "EMAIL" | "PASSWORD"): string | undefined {
  return process.env[`E2E_${role.toUpperCase()}_${field}`];
}

/**
 * The roles the scanner authenticates. `dealer` is the primary lens (the tool
 * walks dealer onboarding first); `admin`/`sales_head` give a higher-privilege
 * session to compare against for cross-role/IDOR probes; `ceo` roams everywhere.
 * Seeded fallbacks mirror tests/e2e/coverage/roles.ts.
 */
export const SCAN_ROLES: ScanRole[] = [
  { role: "dealer", email: cred("dealer", "EMAIL") ?? "dealer@itarang.com", password: cred("dealer", "PASSWORD") ?? "password" },
  { role: "ceo", email: cred("ceo", "EMAIL") ?? "ceo.itarang@gmail.com", password: cred("ceo", "PASSWORD") ?? "password" },
  { role: "sales_head", email: cred("sales_head", "EMAIL") ?? "anirudh@itarang.com", password: cred("sales_head", "PASSWORD") ?? process.env.E2E_TEST_PASSWORD },
  { role: "admin", email: cred("admin", "EMAIL"), password: cred("admin", "PASSWORD") },
];

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export interface LoginResult {
  /** role → captured storage state (cookies + localStorage). */
  sessions: Map<string, StorageState>;
  /** roles that could not be logged in, with the reason. */
  skipped: Array<{ role: string; reason: string }>;
}

/**
 * Log in every role with resolvable credentials against `baseUrl` and capture
 * their storage state. Failures are collected, not thrown — a bad cred for one
 * role must not abort the whole scan.
 */
export async function loginRoles(
  browser: Browser,
  baseUrl: string,
  roles: ScanRole[] = SCAN_ROLES,
  log: (m: string) => void = () => {},
): Promise<LoginResult> {
  const sessions = new Map<string, StorageState>();
  const skipped: Array<{ role: string; reason: string }> = [];

  for (const { role, email, password } of roles) {
    if (!email || !password) {
      skipped.push({ role, reason: "no credentials" });
      continue;
    }
    const context = await browser.newContext({ baseURL: baseUrl });
    try {
      const page = await context.newPage();
      await page.goto("/login", { waitUntil: "domcontentloaded", timeout: 45_000 });
      // Wait for the form to be present + a beat for React to hydrate, so the
      // click runs the JS sign-in handler rather than a native GET form submit
      // (which just reloads /login?email=…&password=…).
      await page.locator('input[name="email"]').waitFor({ state: "visible", timeout: 20_000 });
      await page.waitForTimeout(600);
      await page.locator('input[name="email"]').fill(email);
      await page.locator('input[name="password"]').fill(password);
      await page.getByRole("button", { name: /sign in/i }).click({ force: true });
      await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
      const state = await context.storageState();
      sessions.set(role, state);
      log(`logged in as ${role}`);
    } catch (err) {
      skipped.push({ role, reason: (err as Error).message });
      log(`login failed for ${role}: ${(err as Error).message}`);
    } finally {
      await context.close();
    }
  }

  return { sessions, skipped };
}
