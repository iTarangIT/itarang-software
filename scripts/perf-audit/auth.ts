/**
 * Auth for the perf-audit harness.
 *
 * Reuses fresh storageState files written by `playwright test --project=setup`
 * (tests/.auth/<role>.json); when missing or stale, performs the same form
 * login as tests/e2e/global.setup.ts and writes the state file itself.
 */
import fs from "node:fs";
import path from "node:path";
import type { Browser } from "@playwright/test";
import type { AuditRole } from "./types";

const AUTH_DIR = path.resolve(__dirname, "../../tests/.auth");

interface RoleCreds {
  email: string | undefined;
  password: string | undefined;
}

/** Same seeded sandbox users as tests/e2e/global.setup.ts. */
function credsFor(role: AuditRole): RoleCreds {
  switch (role) {
    case "sales_head":
      return { email: "anirudh@itarang.com", password: process.env.E2E_TEST_PASSWORD };
    case "dealer":
      return { email: "dealer@itarang.com", password: "password" };
    case "ceo":
      return {
        email: process.env.E2E_CEO_EMAIL ?? "ceo.itarang@gmail.com",
        password: process.env.E2E_CEO_PASSWORD ?? "password",
      };
    default:
      return { email: undefined, password: undefined };
  }
}

function stateFileFor(role: AuditRole, baseUrl: string): string {
  const isProd = /crm\.itarang\.com/i.test(baseUrl);
  return path.join(AUTH_DIR, isProd ? `prod-${role}.json` : `${role}.json`);
}

/**
 * Returns a storageState path usable for `browser.newContext()`, logging in
 * first if the cached state is missing or older than PERF_AUTH_MAX_AGE_H
 * (default 12h). Returns undefined for the unauthenticated "public" role.
 */
export async function ensureStorageState(
  browser: Browser,
  role: AuditRole,
  baseUrl: string,
): Promise<string | undefined> {
  if (role === "public") return undefined;

  const stateFile = stateFileFor(role, baseUrl);
  const maxAgeMs = Number(process.env.PERF_AUTH_MAX_AGE_H ?? 12) * 3_600_000;
  if (fs.existsSync(stateFile) && Date.now() - fs.statSync(stateFile).mtimeMs < maxAgeMs) {
    return stateFile;
  }

  const { email, password } = credsFor(role);
  if (!email || !password) {
    throw new Error(
      `[perf-audit] Missing credentials for role "${role}". ` +
        `Set E2E_TEST_PASSWORD / E2E_CEO_EMAIL / E2E_CEO_PASSWORD in .env.test.local`,
    );
  }

  if (/crm\.itarang\.com/i.test(baseUrl) && process.env.E2E_ALLOW_PROD !== "1") {
    throw new Error("[perf-audit] Base URL is production but E2E_ALLOW_PROD=1 is not set.");
  }

  console.log(`[perf-audit] logging in as ${role} (${email}) at ${baseUrl}`);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    // force: true — the decorative rickshaw <img> overlaps the button and
    // intercepts Playwright's pointer-events hit test (see global.setup.ts).
    await page.getByRole("button", { name: /sign in/i }).click({ force: true });
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
    if (/\/change-password/.test(page.url())) {
      throw new Error(`[perf-audit] ${role} account is stuck on /change-password`);
    }
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    await context.storageState({ path: stateFile });
    return stateFile;
  } finally {
    await context.close().catch(() => {});
  }
}
