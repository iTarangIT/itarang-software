/**
 * E-219 — GET /api/dashboard/ceo/green-km
 *
 * Total distance the fleet has covered inside the dashboard window, for the
 * CEO's "Green KM Covered" card. Takes the same window parameters as
 * ./overview (?period=mtd|ytd|fy|inception, or ?from=&to=).
 *
 * WHY THIS IS ITS OWN ROUTE
 *   It is the only CEO figure that lives in the IoT Postgres rather than the
 *   CRM one. That database is reached over an SSH tunnel which is regularly
 *   down (see the "start the SSH tunnel" banner on /ceo/intellicar), and the
 *   client is built with connect_timeout: 8. Inside the overview handler, one
 *   unreachable tunnel would stall every card for eight seconds and then fail
 *   all of them. Split out, the cost is this card alone.
 *
 * WHY IT REPORTS ITS OWN FRESHNESS
 *   `distance_rollup` is written by an aggregator job in the `iot_stack` repo.
 *   Sibling jobs from that stack are known-dead — `trips` has never had a row —
 *   so a rollup that silently stopped updating is a live possibility. A total
 *   frozen at some past date is indistinguishable from a correct one, which on
 *   an executive dashboard is worse than an error. So the newest bucket goes
 *   out with the number and the card says how old it is.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import { getIotSql } from "@/lib/db/iot";
import { resolveWindowParams } from "@/lib/dashboard/salesWindow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin"]);

/** Older than this and the card stops presenting the total as current. */
const STALE_AFTER_HOURS = 48;

export async function GET(req: NextRequest) {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
      );
    }

    const resolved = resolveWindowParams(req.nextUrl.searchParams);
    if (!resolved.ok) {
      return NextResponse.json(
        { success: false, error: { message: resolved.error } },
        { status: 400 },
      );
    }
    const { startStr, endStr, period, label } = resolved.window;

    let iot: ReturnType<typeof getIotSql>;
    try {
      iot = getIotSql();
    } catch (e) {
      // IOT_DATABASE_URL unset — a configuration state, not a failure to
      // report. 200 with reachable:false so the card explains itself rather
      // than rendering an error where a number belongs.
      return NextResponse.json({
        success: true,
        data: {
          period,
          label,
          reachable: false,
          reason: errorMessage(e),
          totalKm: 0,
          vehicles: 0,
          newestBucket: null,
          stale: false,
        },
      });
    }

    try {
      // Optional bounds as composed fragments, matching buildTimeWindow in
      // src/lib/telemetry/charging-sql.ts. Written as `(NULL IS NULL OR time >=
      // $1)` instead, an unbounded window would leave a parameterised OR that
      // Postgres cannot serve from the index on `time`.
      const lower = startStr ? iot`AND time >= ${startStr}` : iot``;
      const upper = endStr ? iot`AND time < ${endStr}` : iot``;

      const [totals] = await iot<
        Array<{ total_km: string | null; vehicles: number | null }>
      >`
        SELECT COALESCE(SUM(distance_km), 0)::float AS total_km,
               COUNT(DISTINCT vehicleno)::int       AS vehicles
        FROM distance_rollup
        WHERE bucket_size = 'day'
          AND distance_km > 0
          ${lower}
          ${upper}
      `;

      // Freshness is a property of the pipeline, not of the chosen window, so
      // it deliberately ignores the bounds above: asking for June and getting
      // June's data says nothing about whether the feed is still running.
      const [freshness] = await iot<Array<{ newest: string | null }>>`
        SELECT MAX(time)::text AS newest
        FROM distance_rollup
        WHERE bucket_size = 'day'
      `;

      const newestBucket = freshness?.newest ?? null;
      const ageHours = newestBucket
        ? (Date.now() - Date.parse(newestBucket)) / 3_600_000
        : null;

      return NextResponse.json({
        success: true,
        data: {
          period,
          label,
          reachable: true,
          totalKm: Number(totals?.total_km || 0),
          vehicles: Number(totals?.vehicles || 0),
          newestBucket,
          stale: ageHours === null || ageHours > STALE_AFTER_HOURS,
        },
      });
    } catch (e) {
      // Tunnel down, credentials rotated, table missing after the AWS move —
      // all the same to the viewer: the number cannot be trusted right now.
      // 200 so one unreachable database does not render as a broken dashboard.
      console.warn("[ceo/green-km] IoT read failed:", errorMessage(e));
      return NextResponse.json({
        success: true,
        data: {
          period,
          label,
          reachable: false,
          reason: errorMessage(e),
          totalKm: 0,
          vehicles: 0,
          newestBucket: null,
          stale: false,
        },
      });
    }
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
