/**
 * Per-battery telemetry scoping + freshness helpers (E-050).
 *
 * Centralises the three things every /api/nbfc/iot/battery/[serial]/* handler
 * needs:
 *
 *   1. Resolving the caller (admin | nbfc tenant member | dealer) — supports
 *      the same triple-guarded NBFC test bypass used by E-027/E-080/E-082 so
 *      Playwright API tests can fabricate any of those three actor types.
 *
 *   2. Authorising access to a specific iot_devices row by serial_number,
 *      returning 404 if the serial does not exist anywhere and 403 if it
 *      exists but the caller's scope cannot see it. Per BRD §6.2.7:
 *        - admin / ceo: any serial
 *        - nbfc tenant: only serials in the tenant's portfolio
 *            (modelled as: serial appears in inventory for a dealer that has
 *             a dealer_nbfc_assignments row to a nbfc whose short_name or
 *             nbfc_id matches the tenant slug; falling back to the explicit
 *             nbfcLoans.vehicleno match on serial_number for the same
 *             tenant_id, since BRD non_functional only requires that the
 *             serial be "in the tenant portfolio" without prescribing the
 *             linkage table — see E-050 audit notes)
 *        - dealer: only serials whose iot_devices.dealer_id matches the
 *            session dealer_id (delivered via the test bypass header
 *            x-nbfc-test-user-id for the loop tests, since dealer auth in
 *            this codebase isn't unified with NBFC tenant auth).
 *
 *   3. Computing data_freshness for an iot_devices row. The dedicated
 *      classifier unit (E-048) has not landed yet at this baseline — the
 *      audit explicitly tags "freshness/data_freshness fields reuse the
 *      classifier from E-048" as a future-looking dependency. Until E-048
 *      ships we ship an inline classifier here that other units can swap
 *      out for the canonical one. Buckets match the BRD response_shape:
 *
 *        - never:   last_seen IS NULL
 *        - fresh:   last_seen <  5 minutes  ago
 *        - idle:    last_seen <  1 hour     ago
 *        - stale:   last_seen <  24 hours   ago
 *        - offline: last_seen >= 24 hours   ago
 *
 *      The /soc endpoint maps this 5-bucket result down to the 3-bucket
 *      contract { fresh | stale | offline } per BRD §6.2.7 by collapsing
 *      idle + stale into "stale".
 */
import { db } from "@/lib/db";
import { eq, and, sql as drizzleSql } from "drizzle-orm";
import {
  iotDevices,
  inventory,
  nbfcLoans,
  nbfcTenants,
  nbfcUsers,
  dealerNbfcAssignments,
  nbfc,
  users,
} from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";

export type CallerRole = "admin" | "ceo" | "nbfc" | "dealer";

export interface BatteryScopeActor {
  role: CallerRole;
  /** uuid of the NBFC tenant when role==="nbfc"; null otherwise. */
  tenant_id: string | null;
  /** dealer_id (varchar) when role==="dealer"; null otherwise. */
  dealer_id: string | null;
  /** "session" | "test_bypass" — diagnostics only. */
  via: "session" | "test_bypass";
}

export type DataFreshness = "fresh" | "idle" | "stale" | "offline" | "never";

export interface IotDeviceRow {
  id: number;
  device_id: string;
  serial_number: string;
  imei_id: string;
  dealer_id: string;
  model: string;
  category: string;
  device_status: string;
  last_seen: Date | null;
  soc_percent: number | null;
  soh_percent: number | null;
  voltage_v: string | null;
  temperature_c: string | null;
  charge_cycles: number | null;
  gps_lat: string | null;
  gps_lng: string | null;
  gps_updated_at: Date | null;
  bms_status: string | null;
  first_usage_at: Date | null;
  registered_at: Date;
  updated_at: Date;
}

const BYPASS_HEADER = "x-nbfc-test-bypass";
const TENANT_HEADER = "x-nbfc-test-tenant-id";
const USER_HEADER = "x-nbfc-test-user-id";
const ROLE_HEADER = "x-nbfc-test-user-role";
const DEALER_HEADER = "x-nbfc-test-dealer-id";

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

function isTestBypass(headers: Headers): boolean {
  if (isProd()) return false;
  const secret = process.env.NBFC_TEST_BYPASS_SECRET;
  if (!secret) return false;
  const provided = headers.get(BYPASS_HEADER);
  return !!provided && provided === secret;
}

/**
 * Resolves the caller for an /api/nbfc/iot/battery/* request.
 *
 * Priority order:
 *   1. Test bypass headers (non-prod only, gated by NBFC_TEST_BYPASS_SECRET).
 *   2. Supabase session — role from app_metadata or users table:
 *        - admin/ceo  -> CallerRole "admin" | "ceo"
 *        - nbfc_partner -> CallerRole "nbfc" + tenant_id from nbfc_users
 *        - dealer -> CallerRole "dealer" + dealer_id from users.dealer_id
 *           (we look up users.dealer_id; absent => still "dealer" with null,
 *            in which case all dealer-scoped queries return 403)
 *   3. Otherwise UNAUTHORIZED.
 */
export async function resolveBatteryActor(headers: Headers): Promise<BatteryScopeActor> {
  if (isTestBypass(headers)) {
    const role = (headers.get(ROLE_HEADER) ?? "").toLowerCase();
    const tenantId = headers.get(TENANT_HEADER);
    const dealerId = headers.get(DEALER_HEADER) ?? headers.get(USER_HEADER);

    if (role === "admin" || role === "ceo") {
      return { role: role as CallerRole, tenant_id: null, dealer_id: null, via: "test_bypass" };
    }
    if (role === "nbfc" || role === "nbfc_partner") {
      if (!tenantId) {
        throw new Error("UNAUTHORIZED: test bypass nbfc role missing tenant header");
      }
      // Verify tenant exists.
      const rows = await db
        .select({ id: nbfcTenants.id })
        .from(nbfcTenants)
        .where(eq(nbfcTenants.id, tenantId))
        .limit(1);
      if (!rows[0]) throw new Error("FORBIDDEN: tenant not found");
      return { role: "nbfc", tenant_id: rows[0].id, dealer_id: null, via: "test_bypass" };
    }
    if (role === "dealer") {
      if (!dealerId) {
        throw new Error("UNAUTHORIZED: test bypass dealer role missing dealer header");
      }
      return { role: "dealer", tenant_id: null, dealer_id: dealerId, via: "test_bypass" };
    }
    throw new Error(`UNAUTHORIZED: test bypass unknown role=${role}`);
  }

  // Production path — Supabase session.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("UNAUTHORIZED: no session");

  const appRole = (user.app_metadata as { role?: string } | undefined)?.role;
  const userMetaRole = (user.user_metadata as { role?: string } | undefined)?.role;
  let role = (appRole ?? userMetaRole ?? "").toLowerCase();
  let dealer_id: string | null = null;

  if (!role) {
    const rows = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    role = (rows[0]?.role ?? "").toLowerCase();
  }

  if (role === "admin" || role === "ceo") {
    return { role: role as CallerRole, tenant_id: null, dealer_id: null, via: "session" };
  }
  if (role === "nbfc_partner") {
    const rows = await db
      .select({ tenant_id: nbfcUsers.tenant_id })
      .from(nbfcUsers)
      .where(eq(nbfcUsers.user_id, user.id))
      .limit(1);
    if (!rows[0]) throw new Error("FORBIDDEN: nbfc_partner without tenant membership");
    return { role: "nbfc", tenant_id: rows[0].tenant_id, dealer_id: null, via: "session" };
  }
  if (role === "dealer") {
    // users.dealer_id is the canonical link for dealer sessions in the rest
    // of the codebase. Best-effort lookup.
    const rows = (await db.execute(
      drizzleSql`select dealer_id::text as dealer_id from users where id = ${user.id} limit 1`,
    )) as unknown as Array<{ dealer_id: string | null }>;
    dealer_id = rows[0]?.dealer_id ?? null;
    return { role: "dealer", tenant_id: null, dealer_id, via: "session" };
  }
  throw new Error(`FORBIDDEN: role=${role} cannot access /api/nbfc/iot/battery`);
}

/** Look up an iot_devices row by serial. Returns null when absent (caller -> 404). */
export async function getDeviceBySerial(serialNumber: string): Promise<IotDeviceRow | null> {
  const rows = await db
    .select()
    .from(iotDevices)
    .where(eq(iotDevices.serial_number, serialNumber))
    .limit(1);
  if (!rows[0]) return null;
  return rows[0] as unknown as IotDeviceRow;
}

/**
 * Returns true iff the actor is allowed to read this serial's telemetry.
 *
 * - admin/ceo -> always.
 * - dealer    -> iot_devices.dealer_id === actor.dealer_id.
 * - nbfc      -> the serial is in the tenant's portfolio. Modelled as the
 *                disjunction of two heuristics so that a serial registered via
 *                E-045 (where iot_devices.dealer_id is set but no nbfc_loans
 *                row exists yet) is still visible if its dealer is assigned to
 *                the tenant's NBFC, and a serial that has reached financing
 *                (nbfc_loans row with vehicleno=serial) is visible regardless
 *                of dealer assignment status. See doc-block at top.
 */
export async function isSerialAuthorised(
  device: IotDeviceRow,
  actor: BatteryScopeActor,
): Promise<boolean> {
  if (actor.role === "admin" || actor.role === "ceo") return true;

  if (actor.role === "dealer") {
    if (!actor.dealer_id) return false;
    return device.dealer_id === actor.dealer_id;
  }

  if (actor.role === "nbfc") {
    if (!actor.tenant_id) return false;

    // Heuristic 1: explicit financing match — a loan row in this tenant with
    // vehicleno == serial.
    const loanRows = await db
      .select({ id: nbfcLoans.loan_application_id })
      .from(nbfcLoans)
      .where(
        and(
          eq(nbfcLoans.tenant_id, actor.tenant_id),
          eq(nbfcLoans.vehicleno, device.serial_number),
        ),
      )
      .limit(1);
    if (loanRows[0]) return true;

    // Heuristic 2: dealer-assignment match. We bridge nbfcTenants(uuid) and
    // nbfc(integer) via slug == nbfc.short_name OR slug == nbfc.nbfc_id. This
    // is the linkage the audit notes flag as "reviewer should confirm" — the
    // BRD does not pin a specific column, so we accept either match.
    const tenantRow = await db
      .select({ slug: nbfcTenants.slug })
      .from(nbfcTenants)
      .where(eq(nbfcTenants.id, actor.tenant_id))
      .limit(1);
    if (!tenantRow[0]) return false;
    const slug = tenantRow[0].slug;

    const assignRows = (await db.execute(
      drizzleSql`
        select 1
        from dealer_nbfc_assignments dna
        join nbfc n on n.id = dna.nbfc_id
        where dna.dealer_id::text = ${device.dealer_id}
          and (n.short_name = ${slug} or n.nbfc_id = ${slug})
          and dna.status = 'active'
        limit 1
      `,
    )) as unknown as Array<{ "?column?": number }>;
    return assignRows.length > 0;
  }

  return false;
}

/**
 * 5-bucket data_freshness classifier (used by /state).
 *
 * Thresholds match the convention used elsewhere in this codebase:
 *   - fresh:   < 5 min
 *   - idle:    < 1 h
 *   - stale:   < 24 h
 *   - offline: >= 24 h
 *   - never:   last_seen IS NULL
 */
export function classifyFreshness(
  lastSeen: Date | null,
  now: Date = new Date(),
): DataFreshness {
  if (!lastSeen) return "never";
  const ageMs = now.getTime() - lastSeen.getTime();
  if (ageMs < 5 * 60 * 1000) return "fresh";
  if (ageMs < 60 * 60 * 1000) return "idle";
  if (ageMs < 24 * 60 * 60 * 1000) return "stale";
  return "offline";
}

/**
 * 3-bucket freshness used by /soc per BRD §6.2.7:
 *   { fresh | stale | offline }.
 * Collapses { idle, stale } -> "stale" and { never } -> "offline".
 */
export function freshnessForSoc(lastSeen: Date | null, now: Date = new Date()): "fresh" | "stale" | "offline" {
  const f = classifyFreshness(lastSeen, now);
  if (f === "fresh") return "fresh";
  if (f === "offline" || f === "never") return "offline";
  return "stale"; // idle | stale
}

/**
 * Standard error -> HTTP status mapping for the /api/nbfc/iot/battery/* family.
 * NOT_FOUND beats FORBIDDEN beats UNAUTHORIZED beats 500 fallback.
 */
export function errorToStatus(message: string): number {
  if (message.startsWith("NOT_FOUND")) return 404;
  if (message.startsWith("FORBIDDEN")) return 403;
  if (message.startsWith("UNAUTHORIZED")) return 401;
  return 500;
}

// Re-exported for tests/imports that don't want to import schema directly.
export { iotDevices, inventory, nbfcLoans, dealerNbfcAssignments, nbfc };
