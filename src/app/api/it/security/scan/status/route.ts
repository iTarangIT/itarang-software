import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityScanRuns } from "@/lib/db/schema";
import { requireSecurityAdmin } from "@/lib/security/route-guard";
import { getScanFreshness } from "@/lib/security/scan-run";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireSecurityAdmin();
  if (!auth.ok) return auth.response;

  const [fresh, rows] = await Promise.all([
    getScanFreshness(),
    db
      .select({
        status: securityScanRuns.status,
        findings_total: securityScanRuns.findings_total,
        started_at: securityScanRuns.started_at,
        finished_at: securityScanRuns.finished_at,
        target_env: securityScanRuns.target_env,
      })
      .from(securityScanRuns)
      .orderBy(desc(securityScanRuns.started_at))
      .limit(1),
  ]);

  const last = rows[0] ?? null;
  return NextResponse.json({
    in_flight: fresh.in_flight,
    status: last?.status ?? null,
    findings_total: last?.findings_total ?? 0,
    last_run_at: fresh.last_run_at?.toISOString() ?? null,
    target_env: last?.target_env ?? null,
  });
}
