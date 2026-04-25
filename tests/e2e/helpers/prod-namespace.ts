import fs from 'node:fs';
import path from 'node:path';

/**
 * Namespacing helpers so every artifact a prod run creates is identifiable and
 * cleanable later. The runId is stable across all tests within a single
 * `playwright test` invocation — written to disk by the first caller, re-read
 * by everyone else.
 */

export const PROD_TAG = '[E2E]';

const RUN_ID_FILE = path.resolve(
  process.cwd(),
  'eval-reports',
  '.last-run-id',
);

let _cachedRunId: string | null = null;

function generateRunId(): string {
  // Compact ULID-ish: timestamp + random suffix. No need for the full ULID
  // package — uniqueness within a single suite invocation is the only
  // requirement.
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `R${ts}${rand}`;
}

export function currentRunId(): string {
  if (_cachedRunId) return _cachedRunId;

  // Honor an explicit override (CI pipelines may want to thread their build id
  // through so artifacts cross-reference back to logs).
  if (process.env.E2E_RUN_ID) {
    _cachedRunId = process.env.E2E_RUN_ID;
    return _cachedRunId;
  }

  fs.mkdirSync(path.dirname(RUN_ID_FILE), { recursive: true });

  // First caller in the process wins. We read-or-write so that worker
  // processes started later in the same suite invocation pick up the same id.
  if (fs.existsSync(RUN_ID_FILE)) {
    const stat = fs.statSync(RUN_ID_FILE);
    // Only trust the file if it was written in the last 10 minutes — older
    // means the previous run crashed without cleanup; start fresh.
    if (Date.now() - stat.mtimeMs < 10 * 60 * 1000) {
      _cachedRunId = fs.readFileSync(RUN_ID_FILE, 'utf-8').trim();
      if (_cachedRunId) return _cachedRunId;
    }
  }

  _cachedRunId = generateRunId();
  fs.writeFileSync(RUN_ID_FILE, _cachedRunId);
  return _cachedRunId;
}

/** Reset the in-process cache and delete the on-disk run-id. */
export function clearRunId(): void {
  _cachedRunId = null;
  if (fs.existsSync(RUN_ID_FILE)) fs.unlinkSync(RUN_ID_FILE);
}

export function tagDealer(name: string): string {
  return `${PROD_TAG} ${name} ${currentRunId()}`.replace(/\s+/g, ' ').trim();
}

export function tagCompany(name: string): string {
  return `${PROD_TAG} ${name} ${currentRunId()}`.replace(/\s+/g, ' ').trim();
}

export function tagLead(name: string): string {
  return `${PROD_TAG} ${name} ${currentRunId()}`.replace(/\s+/g, ' ').trim();
}

/**
 * Phone number for prod test runs. Two modes:
 *   1. E2E_PROD_TEST_PHONE — a single full MSISDN (e.g. +917838597709). All
 *      tests use the same number. Suitable when ops has confirmed exactly one
 *      number is safe to dial.
 *   2. E2E_PROD_TEST_PHONE_PREFIX — 8-digit prefix; suffix is workerIndex.
 *      Default fallback uses +91 700 0070 0XX — 700 is unallocated in India
 *      so collisions with real subscribers are unlikely, but ops should still
 *      confirm Bolna won't actually dial.
 */
export function prodPhone(workerIndex: number): string {
  const explicit = process.env.E2E_PROD_TEST_PHONE;
  if (explicit) {
    if (!/^\+?\d{10,14}$/.test(explicit)) {
      throw new Error(
        `[prod-namespace] E2E_PROD_TEST_PHONE must be 10-14 digits with optional leading +, got "${explicit}"`,
      );
    }
    return explicit.startsWith('+') ? explicit : `+${explicit}`;
  }
  const prefix = process.env.E2E_PROD_TEST_PHONE_PREFIX ?? '70000700';
  if (!/^\d{8}$/.test(prefix)) {
    throw new Error(
      `[prod-namespace] E2E_PROD_TEST_PHONE_PREFIX must be 8 digits, got "${prefix}"`,
    );
  }
  const suffix = String(workerIndex % 100).padStart(2, '0');
  return `+91${prefix}${suffix}`;
}

/** Email convention: `e2e+<runId>@itarang.com` so ops can filter inbound. */
export function prodEmail(scope = 'dealer'): string {
  return `e2e+${scope}-${currentRunId().toLowerCase()}@itarang.com`;
}
