/**
 * RELEASE-BLOCKING.
 *
 * The digest ticker must stay DARK outside production.
 *
 * This is not a hypothetical. On 2026-09-07, `npm run dev` — which reads
 * `.env.local`, which points at a shared AWS database — booted the ticker, and
 * within 195 seconds it had claimed the day's slot and mailed a real digest to
 * care.itarang@gmail.com from a developer's laptop. Worse than the stray email:
 * the claim is what makes a slot once-a-day, so having consumed it, the DEPLOYED
 * app could no longer send the digest the recipients were actually waiting for.
 * One developer starting a dev server silently cancelled production's mail.
 *
 * Every other ticker in instrumentation-node.ts is safe to run in dev because
 * its work is idempotent, internal, or self-correcting. This one sends once, to
 * a fixed external address, and records that it did — and since E-288 it does so
 * for every registered kind at once.
 *
 * If you are here because this test failed, do not delete the assertion. The
 * ticker needs BOTH:
 *   1. `process.env.NODE_ENV !== "production"` in the guard, and
 *   2. an `ENABLE_DEALER_VALIDATION_DIGEST !== "1"` escape hatch for anyone who
 *      genuinely wants it locally,
 * before it returns. To exercise the mail without consuming a slot, use a
 * settings screen's "Send test now" (slot='test', outside the unique index) or
 * `scripts/verify-digests.ts <kind> <day> --render`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  join(process.cwd(), "src", "instrumentation-node.ts"),
  "utf8",
);

/** The body of startDigestTicker, up to its first kickoff. */
function tickerBody(): string {
  const start = SRC.indexOf("export async function startDigestTicker");
  expect(start, "startDigestTicker is gone from instrumentation-node.ts").toBeGreaterThan(-1);

  const end = SRC.indexOf("const TICK_INTERVAL_MS", start);
  expect(end, "the ticker no longer looks like the other tickers").toBeGreaterThan(start);

  return SRC.slice(start, end);
}

describe("digest ticker", () => {
  it("refuses to run outside production without an explicit opt-in", () => {
    const body = tickerBody();

    expect(
      body,
      'the ticker must check `process.env.NODE_ENV !== "production"` before it ' +
        "starts — without it, any dev server pointed at .env.local mails a real " +
        "digest and consumes production's slot for the day",
    ).toMatch(/NODE_ENV\s*!==\s*["']production["']/);

    expect(
      body,
      "the production guard needs an ENABLE_DEALER_VALIDATION_DIGEST=1 escape " +
        "hatch, or there is no way to exercise the ticker locally at all",
    ).toMatch(/ENABLE_DEALER_VALIDATION_DIGEST\s*!==\s*["']1["']/);

    // The guard has to RETURN. A guard that only logs is not a guard.
    expect(
      body,
      "the non-production branch must `return`, not merely log a warning",
    ).toMatch(/NODE_ENV[\s\S]{0,600}?\breturn;/);
  });

  it("still honours the ENABLE_DEALER_VALIDATION_DIGEST=0 opt-out", () => {
    expect(tickerBody()).toMatch(/ENABLE_DEALER_VALIDATION_DIGEST\s*===\s*["']0["']/);
  });

  it("skips on Vercel, like every other ticker in this file", () => {
    expect(tickerBody()).toMatch(/VERCEL\s*===\s*["']1["']/);
  });

  it("runs every registered kind, not just one", () => {
    // The whole point of E-288. A ticker that hard-codes one kind would leave a
    // newly registered digest silently never sending.
    expect(SRC.slice(SRC.indexOf("export async function startDigestTicker"))).toMatch(
      /runAllDigests/,
    );
  });
});
