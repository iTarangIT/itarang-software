/**
 * GET /api/admin/nbfc/anomaly-flag  (E-066 — BRD §6.3.2)
 *
 * Admin-only listing of currently flagged NBFCs. Returns the open flag rows
 * (cleared_at IS NULL) joined with tenant display name so the Ops dashboard
 * can render the table without a second round-trip.
 *
 * Optional query string:
 *   ?include_cleared=1  — also return rows whose cleared_at is set
 *                         (cap at 200 most-recent; for the audit log view).
 *
 * Auth: resolveAdminActor; non-admins -> 403.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, isNull, sql, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcAnomalyFlags, nbfcTenants } from "@/lib/db/schema";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await resolveAdminActor(req.headers);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }

  const includeCleared =
    req.nextUrl.searchParams.get("include_cleared") === "1";

  try {
    const baseQuery = db
      .select({
        id: nbfcAnomalyFlags.id,
        nbfc_id: nbfcAnomalyFlags.nbfc_id,
        nbfc_name: nbfcTenants.display_name,
        severity: nbfcAnomalyFlags.severity,
        reasons: nbfcAnomalyFlags.reasons,
        flagged_at: nbfcAnomalyFlags.flagged_at,
        cleared_at: nbfcAnomalyFlags.cleared_at,
      })
      .from(nbfcAnomalyFlags)
      .innerJoin(
        nbfcTenants,
        eq(nbfcAnomalyFlags.nbfc_id, nbfcTenants.id),
      );

    const rows = includeCleared
      ? await baseQuery
          .orderBy(desc(nbfcAnomalyFlags.flagged_at))
          .limit(200)
      : await baseQuery
          .where(isNull(nbfcAnomalyFlags.cleared_at))
          .orderBy(desc(nbfcAnomalyFlags.flagged_at));

    const summary = await db
      .select({
        severity: nbfcAnomalyFlags.severity,
        n: sql<string>`count(*)`,
      })
      .from(nbfcAnomalyFlags)
      .where(isNull(nbfcAnomalyFlags.cleared_at))
      .groupBy(nbfcAnomalyFlags.severity);

    const counts = { red: 0, amber: 0 };
    for (const s of summary) {
      const n = Number(s.n) || 0;
      if (s.severity === "red") counts.red = n;
      else if (s.severity === "amber") counts.amber = n;
    }

    return NextResponse.json({
      ok: true,
      open_counts: counts,
      flags: rows,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[admin/nbfc/anomaly-flag GET] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
