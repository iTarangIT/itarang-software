/**
 * E-029 — Nightly cron: compute Credit Default Score (CDS) per active
 * loan_sanction and persist into borrower_risk_scores. See BRD §6.1.5.
 *
 * Auth model (mirrors /api/cron/nbfc-cor-expiry):
 *   - Vercel cron header `x-vercel-cron` is trusted automatically.
 *   - Bearer CRON_SECRET in `authorization` is accepted from manual
 *     callers and from the test runner.
 *   - In non-production we additionally allow unauthenticated triggers
 *     (matches sibling cron routes for parity in dev/test).
 *   - Optional admin-bypass header `x-nbfc-test-bypass` ==
 *     NBFC_TEST_BYPASS_SECRET keeps Playwright/test runners working
 *     under NBFC_TEST_BYPASS=1.
 *
 * Response shape (per E-029 YAML):
 *   { ok, computed_count, skipped_count, run_at }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runCdsNightlyJob } from "@/lib/nbfc/cds/computeCds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestSchema = z.object({}).optional();

function isAuthorised(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;

  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;

  if (
    process.env.NBFC_TEST_BYPASS === "1" &&
    process.env.NBFC_TEST_BYPASS_SECRET &&
    req.headers.get("x-nbfc-test-bypass") ===
      process.env.NBFC_TEST_BYPASS_SECRET
  ) {
    return true;
  }

  if (process.env.NODE_ENV !== "production") return true;

  return false;
}

async function handle(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json(
      { ok: false, error: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  // Body is permitted but unused — schema parse keeps surface honest.
  try {
    const text = await req.text();
    if (text) {
      const parsed = RequestSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        return NextResponse.json(
          { ok: false, error: "BAD_REQUEST" },
          { status: 400 },
        );
      }
    }
  } catch {
    // Empty / non-JSON bodies are fine for a cron trigger.
  }

  try {
    const result = await runCdsNightlyJob();
    return NextResponse.json({
      ok: true,
      computed_count: result.computed_count,
      skipped_count: result.skipped_count,
      run_at: result.run_at,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cron/nbfc/compute-cds] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return handle(req);
}

export async function GET(req: NextRequest) {
  // Vercel cron triggers a GET — keep it equivalent.
  return handle(req);
}
