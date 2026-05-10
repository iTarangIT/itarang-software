/**
 * E-071 — GET /api/audit-log
 *
 * Admin Audit Log query API with filters and tenant scoping.
 *
 * Auth model (per BRD §6.3.5):
 *   - Admin JWT: sees rows from ALL NBFCs.
 *   - NBFC JWT: sees only rows where the caller's nbfc tenant_id matches
 *     (entity_type='nbfc_action' OR new_data.tenant_id = caller_tenant_id).
 *
 * Query view on the existing `audit_logs` table — no schema changes.
 *
 * Filterable params (all optional except pagination):
 *   from           — ISO timestamp lower bound (timestamp >= from)
 *   to             — ISO timestamp upper bound (timestamp <= to)
 *   action         — exact action code match
 *   requestedBy    — uuid match against performed_by
 *   approvedBy     — uuid match against new_data.approved_by
 *   status         — executed | pending | rejected (against new_data.exec_status)
 *   entityId       — exact match against entity_id
 *   page           — 1-based page (default 1)
 *   page_size      — page size (default 50, max 200)
 *
 * Results ordered by timestamp DESC, paginated.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq, gte, lte, sql, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, users, nbfcUsers } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";

/**
 * Mirror of the gated admin/nbfc test-bypass check. Triple-guarded:
 *   1. NODE_ENV !== 'production'
 *   2. Server has NBFC_TEST_BYPASS_SECRET env
 *   3. Request carries x-nbfc-test-bypass header equal to that secret
 */
function isAdminTestBypass(headers: Headers): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const secret = process.env.NBFC_TEST_BYPASS_SECRET;
  if (!secret) return false;
  const provided = headers.get("x-nbfc-test-bypass");
  return !!provided && provided === secret;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    action: z.string().optional(),
    requestedBy: z.string().uuid().optional(),
    approvedBy: z.string().uuid().optional(),
    status: z.enum(["executed", "pending", "rejected"]).optional(),
    entityId: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

type Caller =
  | { mode: "admin"; user_id: string; role: string }
  | { mode: "nbfc"; user_id: string; tenant_id: string; role: string };

/**
 * Resolve the caller. Two modes:
 *   - admin:  the canonical admin gate (or admin-test-bypass header).
 *   - nbfc:   tenant-scoped actor (session OR nbfc-test-bypass header with
 *             x-nbfc-test-tenant-id).
 *
 * In test bypass mode we prefer admin if x-nbfc-test-admin-id is provided,
 * otherwise fall back to nbfc tenant bypass when x-nbfc-test-tenant-id is
 * present. In production (no bypass), we attempt admin first; if that fails
 * with 403, we attempt nbfc tenant resolution.
 */
async function resolveCaller(req: NextRequest): Promise<Caller> {
  if (isAdminTestBypass(req.headers)) {
    const adminId = req.headers.get("x-nbfc-test-admin-id");
    if (adminId) {
      // admin-test-bypass path
      const role = req.headers.get("x-nbfc-test-admin-role") ?? "admin";
      return { mode: "admin", user_id: adminId, role };
    }
    const tenantId = req.headers.get("x-nbfc-test-tenant-id");
    if (tenantId) {
      const actor = await resolveActor(req.headers);
      return {
        mode: "nbfc",
        user_id: actor.user_id,
        tenant_id: actor.tenant_id,
        role: actor.role,
      };
    }
    // Bypass header set but neither variant — fall through to admin uuid bypass.
    const userId = req.headers.get("x-nbfc-test-user-id");
    const userRole = req.headers.get("x-nbfc-test-user-role") ?? "admin";
    if (userId) {
      return { mode: "admin", user_id: userId, role: userRole };
    }
    throw new Error("UNAUTHORIZED: test bypass missing actor headers");
  }

  // Production path — try admin first, then NBFC.
  const admin = await requireAdminOrTestBypass(req.headers);
  if (admin.ok) {
    return { mode: "admin", user_id: admin.user.id, role: admin.user.role };
  }
  // Fall through to NBFC tenant resolution.
  const actor = await resolveActor(req.headers);
  return {
    mode: "nbfc",
    user_id: actor.user_id,
    tenant_id: actor.tenant_id,
    role: actor.role,
  };
}

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function GET(req: NextRequest) {
  try {
    const caller = await resolveCaller(req);

    // Parse query params
    const url = new URL(req.url);
    const raw = Object.fromEntries(url.searchParams.entries());
    const parsed = Query.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const q = parsed.data;

    const conds = [];
    if (q.from) conds.push(gte(auditLogs.timestamp, new Date(q.from)));
    if (q.to) conds.push(lte(auditLogs.timestamp, new Date(q.to)));
    if (q.action) conds.push(eq(auditLogs.action, q.action));
    if (q.requestedBy) conds.push(eq(auditLogs.performed_by, q.requestedBy));
    if (q.entityId) conds.push(eq(auditLogs.entity_id, q.entityId));
    if (q.approvedBy) {
      conds.push(
        sql`${auditLogs.new_data} ->> 'approved_by' = ${q.approvedBy}`,
      );
    }
    if (q.status) {
      conds.push(sql`${auditLogs.new_data} ->> 'exec_status' = ${q.status}`);
    }

    // Tenant scoping for NBFC callers
    if (caller.mode === "nbfc") {
      conds.push(
        sql`(${auditLogs.entity_type} = 'nbfc_action' AND ${auditLogs.new_data} ->> 'tenant_id' = ${caller.tenant_id}) OR (${auditLogs.new_data} ->> 'tenant_id' = ${caller.tenant_id})`,
      );
    }

    const whereExpr = conds.length > 0 ? and(...conds) : undefined;

    const offset = (q.page - 1) * q.page_size;

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(whereExpr);

    const rows = await db
      .select({
        id: auditLogs.id,
        timestamp: auditLogs.timestamp,
        entity_type: auditLogs.entity_type,
        entity_id: auditLogs.entity_id,
        action: auditLogs.action,
        performed_by: auditLogs.performed_by,
        new_data: auditLogs.new_data,
      })
      .from(auditLogs)
      .where(whereExpr)
      .orderBy(desc(auditLogs.timestamp))
      .limit(q.page_size)
      .offset(offset);

    // Resolve user info for performed_by + approved_by ids in a single query.
    const userIds = new Set<string>();
    for (const r of rows) {
      if (r.performed_by) userIds.add(r.performed_by);
      const nd = (r.new_data ?? {}) as Record<string, unknown>;
      const approvedBy =
        typeof nd.approved_by === "string" ? nd.approved_by : null;
      if (approvedBy) userIds.add(approvedBy);
    }

    type UserInfo = { id: string; name: string; role: string };
    const userMap = new Map<string, UserInfo>();
    if (userIds.size > 0) {
      const ids = [...userIds];
      const found = await db
        .select({
          id: users.id,
          name: users.name,
          role: users.role,
        })
        .from(users)
        .where(inArray(users.id, ids));
      for (const u of found) {
        userMap.set(u.id, { id: u.id, name: u.name, role: u.role });
      }
      // Fallback to nbfc_users role if user row not found in users table.
      const missing = ids.filter((id) => !userMap.has(id));
      if (missing.length > 0) {
        const nrows = await db
          .select({ user_id: nbfcUsers.user_id, role: nbfcUsers.role })
          .from(nbfcUsers)
          .where(inArray(nbfcUsers.user_id, missing));
        for (const n of nrows) {
          if (!userMap.has(n.user_id)) {
            userMap.set(n.user_id, {
              id: n.user_id,
              name: "",
              role: n.role,
            });
          }
        }
      }
    }

    const projected = rows.map((r) => {
      const nd = (r.new_data ?? {}) as Record<string, unknown>;
      const reason_code =
        typeof nd.reason_code === "string" ? nd.reason_code : null;
      const exec_status =
        typeof nd.exec_status === "string" ? nd.exec_status : null;
      const approvedById =
        typeof nd.approved_by === "string" ? nd.approved_by : null;

      const requested_by = r.performed_by
        ? (userMap.get(r.performed_by) ?? {
            id: r.performed_by,
            name: "",
            role: "",
          })
        : { id: null, name: null, role: null };

      const approved_by = approvedById
        ? (userMap.get(approvedById) ?? {
            id: approvedById,
            name: "",
            role: "",
          })
        : { id: null, name: null, role: null };

      return {
        id: r.id,
        timestamp:
          r.timestamp instanceof Date
            ? r.timestamp.toISOString()
            : (r.timestamp ?? null),
        entity_id: r.entity_id,
        action: r.action,
        reason_code,
        requested_by,
        approved_by,
        exec_status,
      };
    });

    return NextResponse.json({
      rows: projected,
      page: q.page,
      page_size: q.page_size,
      total: Number(count ?? 0),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
