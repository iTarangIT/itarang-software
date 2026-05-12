/**
 * E-051 — NBFC fleet telemetry query API (BRD §6.2.7).
 *
 * GET /api/iot/fleet?nbfcId=NBFC-001&status=online|offline|all
 *
 * Returns aggregate fleet stats for the NBFC's portfolio:
 *   { total, online, offline, alerts: [ { serial_number, rule, severity, triggered_at } ] }
 *
 * Auth model:
 *   - admin / ceo / business_head / sales_head — may query any nbfcId.
 *   - nbfc_partner (NBFC JWT) — must equal the requested nbfcId, else 403.
 *   - dealer — always 403 (fleet view is NBFC-scoped).
 *
 * Caller's "own" nbfcId is resolved via:
 *   (a) test bypass header `x-nbfc-test-caller-nbfc-id` (when triple-guarded
 *       bypass is active), or
 *   (b) `nbfc_partner` session → join nbfc_users → nbfc_tenants.slug or
 *       display_name → nbfc.short_name match. Best-effort; if no match, 403.
 *
 * Portfolio resolution:
 *   1. Find nbfc.id for the requested nbfcId (varchar).
 *   2. Pull dealer ids from dealer_nbfc_assignments WHERE status='active'.
 *   3. Look up dealers.dealer_id (varchar) for those ids — this matches
 *      iot_devices.dealer_id (varchar).
 *   4. Pull iot_devices for those dealer_id codes; compute counts.
 *   5. Pull open telemetry_alerts (resolved_at IS NULL) for those serials.
 *
 * Online definition (BRD logic step 6): device_status='online' AND
 * last_seen >= now() - 15 minutes.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  nbfc,
  dealers,
  dealerNbfcAssignments,
  iotDevices,
  telemetryAlerts,
  nbfcUsers,
  nbfcTenants,
} from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  nbfcId: z.string().min(1),
  status: z.enum(["online", "offline", "all"]).default("all"),
});

const ADMIN_ROLES = new Set([
  "admin",
  "ceo",
  "business_head",
  "sales_head",
]);

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

function isTestBypassRequest(headers: Headers): boolean {
  if (isProd()) return false;
  const secret = process.env.NBFC_TEST_BYPASS_SECRET;
  if (!secret) return false;
  const provided = headers.get("x-nbfc-test-bypass");
  return !!provided && provided === secret;
}

interface CallerCtx {
  role: string;
  /** nbfcId varchar (e.g. "NBFC-001") that the caller is bound to, if any. */
  callerNbfcId: string | null;
}

async function resolveCaller(req: NextRequest): Promise<CallerCtx> {
  // Test bypass path — used by the loop's Playwright tests.
  if (isTestBypassRequest(req.headers)) {
    const role = (
      req.headers.get("x-nbfc-test-user-role") ?? "nbfc_partner"
    ).toLowerCase();
    const callerNbfcId =
      req.headers.get("x-nbfc-test-caller-nbfc-id") ?? null;
    return { role, callerNbfcId };
  }

  // Session path.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("UNAUTHORIZED: no session");
  }
  const appRole = (user.app_metadata as { role?: string } | undefined)?.role;
  const userMetaRole = (user.user_metadata as { role?: string } | undefined)
    ?.role;
  const role = (appRole ?? userMetaRole ?? "user").toLowerCase();

  // Try resolving caller's nbfcId from nbfc_users -> nbfc_tenants.slug -> nbfc.short_name
  let callerNbfcId: string | null = null;
  if (role === "nbfc_partner") {
    const rows = await db
      .select({ slug: nbfcTenants.slug, display_name: nbfcTenants.display_name })
      .from(nbfcUsers)
      .innerJoin(nbfcTenants, eq(nbfcUsers.tenant_id, nbfcTenants.id))
      .where(eq(nbfcUsers.user_id, user.id))
      .limit(1);
    if (rows[0]) {
      // Best-effort mapping: tenant slug or display_name -> nbfc.short_name.
      const matched = await db
        .select({ nbfc_id: nbfc.nbfc_id })
        .from(nbfc)
        .where(
          sql`lower(${nbfc.short_name}) = lower(${rows[0].slug}) OR lower(${nbfc.short_name}) = lower(${rows[0].display_name})`,
        )
        .limit(1);
      callerNbfcId = matched[0]?.nbfc_id ?? null;
    }
  }
  return { role, callerNbfcId };
}

export async function GET(req: NextRequest) {
  try {
    // 1. Validate query.
    const url = new URL(req.url);
    const parsed = querySchema.safeParse({
      nbfcId: url.searchParams.get("nbfcId") ?? "",
      status: url.searchParams.get("status") ?? "all",
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST", issues: parsed.error.issues },
        { status: 422 },
      );
    }
    const { nbfcId, status } = parsed.data;

    // 2. Resolve caller and enforce role-based access.
    const caller = await resolveCaller(req);
    if (caller.role === "dealer") {
      return NextResponse.json(
        { ok: false, error: "FORBIDDEN: dealer cannot query fleet" },
        { status: 403 },
      );
    }
    const isAdmin = ADMIN_ROLES.has(caller.role);
    const isNbfc =
      caller.role === "nbfc" || caller.role === "nbfc_partner";

    if (!isAdmin && !isNbfc) {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role=${caller.role}` },
        { status: 403 },
      );
    }
    if (isNbfc && caller.callerNbfcId !== nbfcId) {
      return NextResponse.json(
        { ok: false, error: "FORBIDDEN: nbfcId mismatch" },
        { status: 403 },
      );
    }

    // 3. Resolve nbfc.id (int) for the requested nbfcId (varchar).
    const [nbfcRow] = await db
      .select({ id: nbfc.id })
      .from(nbfc)
      .where(eq(nbfc.nbfc_id, nbfcId))
      .limit(1);
    if (!nbfcRow) {
      // Empty portfolio for unknown nbfc — return zeros so admin queries
      // against not-yet-onboarded NBFCs degrade gracefully.
      return NextResponse.json({
        total: 0,
        online: 0,
        offline: 0,
        alerts: [],
      });
    }

    // 4. Resolve dealer ids active under this NBFC.
    const assignmentRows = await db
      .select({ dealer_id: dealerNbfcAssignments.dealer_id })
      .from(dealerNbfcAssignments)
      .where(
        and(
          eq(dealerNbfcAssignments.nbfc_id, nbfcRow.id),
          eq(dealerNbfcAssignments.status, "active"),
        ),
      );
    const dealerIntIds = assignmentRows.map((r) => r.dealer_id);

    let dealerCodes: string[] = [];
    if (dealerIntIds.length > 0) {
      const dealerRows = await db
        .select({ dealer_id: dealers.dealer_id })
        .from(dealers)
        .where(inArray(dealers.id, dealerIntIds));
      dealerCodes = dealerRows
        .map((d) => d.dealer_id)
        .filter((c): c is string => typeof c === "string" && c.length > 0);
    }

    if (dealerCodes.length === 0) {
      return NextResponse.json({
        total: 0,
        online: 0,
        offline: 0,
        alerts: [],
      });
    }

    // 5. Pull iot_devices for the portfolio and compute counts.
    const deviceRows = await db
      .select({
        serial_number: iotDevices.serial_number,
        device_status: iotDevices.device_status,
        last_seen: iotDevices.last_seen,
      })
      .from(iotDevices)
      .where(inArray(iotDevices.dealer_id, dealerCodes));

    const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
    const isOnline = (d: (typeof deviceRows)[number]): boolean => {
      if (d.device_status !== "online") return false;
      if (!d.last_seen) return false;
      return new Date(d.last_seen).getTime() >= fifteenMinAgo;
    };

    const total = deviceRows.length;
    const online = deviceRows.filter(isOnline).length;
    const offline = total - online;

    // 6. Apply status filter — only changes the alerts surface, summary
    //    counts always reflect the unfiltered portfolio.
    let alertSerials: string[] = deviceRows.map((d) => d.serial_number);
    if (status === "online") {
      alertSerials = deviceRows.filter(isOnline).map((d) => d.serial_number);
    } else if (status === "offline") {
      alertSerials = deviceRows
        .filter((d) => !isOnline(d))
        .map((d) => d.serial_number);
    }

    // 7. Pull open telemetry_alerts for the (possibly filtered) serials.
    let alerts: Array<{
      serial_number: string;
      rule: string;
      severity: string;
      triggered_at: string;
    }> = [];
    if (alertSerials.length > 0) {
      const alertRows = await db
        .select({
          serial_number: telemetryAlerts.serial_number,
          rule: telemetryAlerts.rule,
          severity: telemetryAlerts.severity,
          triggered_at: telemetryAlerts.triggered_at,
        })
        .from(telemetryAlerts)
        .where(
          and(
            inArray(telemetryAlerts.serial_number, alertSerials),
            isNull(telemetryAlerts.resolved_at),
          ),
        );
      alerts = alertRows.map((r) => ({
        serial_number: r.serial_number,
        rule: r.rule,
        severity: r.severity,
        triggered_at:
          r.triggered_at instanceof Date
            ? r.triggered_at.toISOString()
            : String(r.triggered_at),
      }));
    }

    return NextResponse.json({ total, online, offline, alerts });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED")
      ? 401
      : msg.startsWith("FORBIDDEN")
        ? 403
        : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
