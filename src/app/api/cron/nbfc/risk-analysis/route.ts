/**
 * E-187 — Nightly cron: run the risk-hypothesis engine for every active tenant.
 *
 * Before this existed, the engine's only caller was the "Re-run analysis"
 * button. Cards persisted forever with no expiry and no freshness signal, so the
 * Risk page presented a number computed in March exactly as it presented one
 * computed five minutes ago.
 *
 * NOTE ON SCHEDULING: `vercel.json` is NOT what fires this. We deploy on
 * Hostinger via PM2, where Vercel cron does not exist (see docs/DEPLOY_RUNBOOK.md).
 * The real schedule is a crontab entry on the VPS:
 *
 *   30 1 * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *              http://127.0.0.1:3002/api/cron/nbfc/risk-analysis
 *
 * Auth model mirrors /api/cron/nbfc/compute-cds.
 *
 * Tenants are swept sequentially, not in parallel: each run calls an LLM and
 * (when configured) the Python sandbox, and a fan-out across every NBFC at once
 * would stampede both. A tenant already running — someone hit the button a
 * minute ago — is skipped, not queued.
 */
import { NextRequest, NextResponse } from "next/server";
import { runRiskWorkflow } from "@/lib/ai/langgraph/risk-hypothesis-graph";
import { RunInFlightError, listActiveTenants } from "@/lib/nbfc/risk-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sequential across tenants, ~30-60s each. Raise this if the tenant count grows.
export const maxDuration = 800;

function isAuthorised(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;

  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;

  if (
    process.env.NBFC_TEST_BYPASS === "1" &&
    process.env.NBFC_TEST_BYPASS_SECRET &&
    req.headers.get("x-nbfc-test-bypass") === process.env.NBFC_TEST_BYPASS_SECRET
  ) {
    return true;
  }

  if (process.env.NODE_ENV !== "production") return true;

  return false;
}

interface TenantOutcome {
  tenant: string;
  status: "completed" | "skipped" | "failed";
  cards_generated?: number;
  cards_computed?: number;
  cards_inconclusive?: number;
  cards_errored?: number;
  error?: string;
}

async function handle(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  const runAt = new Date();
  const tenants = await listActiveTenants();
  const results: TenantOutcome[] = [];

  for (const tenant of tenants) {
    try {
      const summary = await runRiskWorkflow(tenant, { trigger: "cron" });
      results.push({
        tenant: tenant.slug,
        status: "completed",
        cards_generated: summary.cards_generated,
        cards_computed: summary.cards_computed,
        cards_inconclusive: summary.cards_inconclusive,
        cards_errored: summary.cards_errored,
      });
    } catch (e) {
      if (e instanceof RunInFlightError) {
        results.push({ tenant: tenant.slug, status: "skipped", error: "already running" });
        continue;
      }
      // One tenant's failure must not abort the sweep for the rest. The run row
      // is already marked failed with the reason by runRiskWorkflow.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cron/risk-analysis] tenant ${tenant.slug} failed:`, msg);
      results.push({ tenant: tenant.slug, status: "failed", error: msg });
    }
  }

  return NextResponse.json({
    ok: true,
    run_at: runAt.toISOString(),
    tenant_count: tenants.length,
    completed: results.filter((r) => r.status === "completed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
}

export async function POST(req: NextRequest) {
  return handle(req);
}

// Cron runners that only issue GETs (and Vercel cron) hit the same handler.
export async function GET(req: NextRequest) {
  return handle(req);
}
