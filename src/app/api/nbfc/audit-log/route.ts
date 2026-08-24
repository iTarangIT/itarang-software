/**
 * GET /api/nbfc/audit-log — BRD §6.3.5
 *
 * Unified NBFC-tenant audit feed. Merges three evidence sources:
 *   - nbfc_audit_log              → immutable RBI-compliance trail (before/after JSON)
 *   - nbfc_borrower_actions       → mutable action state (status + requested_by)
 *   - nbfc_immobilisation_actions → IoT execution stamps + borrower-notice timestamp
 *
 * Filters (per BRD §6.3.5):
 *   from, to               → ISO date / datetime range over created_at
 *   action                 → exact action_type match
 *   status                 → executed | pending | rejected | approved
 *   requestedBy            → user_id (uuid) filter
 *   entityId               → substring match on loan_sanction_id / IMEI / lead_id
 *   page, limit            → pagination (limit max 100)
 *   format=csv             → returns text/csv (requires `purpose` ≥10 chars)
 *
 * Tenant scoping: every query is bound to `actor.tenant_id`. A CSV export is
 * itself recorded as an `audit_log_export` row so the export trail closes the
 * loop.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { db } from "@/lib/db";
import { and, desc, eq, gte, lte, ilike, or } from "drizzle-orm";
import {
  nbfcAuditLog,
  nbfcBorrowerActions,
  nbfcImmobilisationActions,
  nbfcUsers,
  users as usersTable,
} from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION_CODES = [
  "payment_reminder",
  "field_visit",
  "immobilisation",
  "battery_immobilisation",
  "loan_restructuring",
  "flag_for_recovery",
  "unflag_for_recovery",
  "bulk_immobilisation",
  "pii_data_access",
  "audit_log_export",
  "risk_rule_threshold_change",
  "risk_score_run",
  // E-238 — offer negotiation. `offer_negotiate` rows are written with the
  // DEALER's users.id against this tenant, so the NBFC's own log shows who
  // asked for what; `offer_fix` is the officer who froze the terms.
  "offer_negotiate",
  "offer_fix",
] as const;

const STATUS_CODES = [
  "executed",
  "pending",
  "pending_approval",
  "pending_dual_approval",
  "approved",
  "auto_approved",
  "rejected",
  "expired",
] as const;

const Query = z.object({
  from: z.string().datetime().optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  to: z.string().datetime().optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  action: z.enum(ACTION_CODES).optional(),
  status: z.enum(STATUS_CODES).optional(),
  requestedBy: z.string().uuid().optional(),
  entityId: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  format: z.enum(["json", "csv"]).default("json"),
  purpose: z.string().trim().min(10).max(500).optional(),
});

export interface AuditLogRow {
  id: string;
  source: "audit_log" | "borrower_action" | "immobilisation_action";
  timestamp: string | null;
  entity: { type: "loan" | "battery" | "lead" | "system"; id: string | null; label: string | null };
  action: string;
  action_label: string;
  reason_code: string | null;
  reason_text: string | null;
  requested_by: { id: string | null; name: string | null; role: string | null };
  approved_by: { id: string | null; name: string | null; role: string | null } | null;
  status: string;
  before_state: unknown;
  after_state: unknown;
  borrower_notified_at: string | null;
  payload: unknown;
}

const ACTION_LABELS: Record<string, string> = {
  payment_reminder: "Payment reminder",
  field_visit: "Field visit",
  immobilisation: "Immobilisation",
  battery_immobilisation: "Battery immobilisation (IoT)",
  loan_restructuring: "Loan restructuring",
  flag_for_recovery: "Flag for recovery",
  unflag_for_recovery: "Recovery flag withdrawn",
  bulk_immobilisation: "Bulk immobilisation",
  pii_data_access: "PII access",
  audit_log_export: "Audit log export",
  risk_rule_threshold_change: "Risk rule threshold change",
  risk_score_run: "Risk score run",
};

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

function parseRangeBound(v: string | undefined, end: boolean): Date | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return new Date(`${v}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function inferEntity(
  action: string,
  payload: Record<string, unknown> | null,
  loanSanctionId: string | null,
  imei: string | null,
): AuditLogRow["entity"] {
  const ctx =
    payload && typeof payload.context === "object" && payload.context !== null
      ? (payload.context as Record<string, unknown>)
      : null;
  if (ctx?.entity_type === "lead" && typeof ctx.lead_id === "string") {
    return { type: "lead", id: ctx.lead_id, label: `Lead ${ctx.lead_id}` };
  }
  if (imei) {
    return { type: "battery", id: imei, label: imei };
  }
  if (loanSanctionId) {
    return { type: "loan", id: loanSanctionId, label: loanSanctionId };
  }
  if (action === "audit_log_export" || action === "risk_rule_threshold_change") {
    return { type: "system", id: null, label: "System" };
  }
  return { type: "system", id: null, label: "—" };
}

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);

    const url = new URL(req.url);
    const parsed = Query.safeParse({
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      action: url.searchParams.get("action") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      requestedBy: url.searchParams.get("requestedBy") ?? undefined,
      entityId: url.searchParams.get("entityId") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      format: url.searchParams.get("format") ?? undefined,
      purpose: url.searchParams.get("purpose") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const q = parsed.data;

    if (q.format === "csv" && (!q.purpose || q.purpose.length < 10)) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: purpose (≥10 chars) required for csv export" },
        { status: 400 },
      );
    }

    const from = parseRangeBound(q.from, false);
    const to = parseRangeBound(q.to, true);
    const tenantId = actor.tenant_id;

    // ── 1. nbfc_audit_log ───────────────────────────────────────────────────
    const auditConds = [eq(nbfcAuditLog.tenant_id, tenantId)];
    if (from) auditConds.push(gte(nbfcAuditLog.created_at, from));
    if (to) auditConds.push(lte(nbfcAuditLog.created_at, to));
    if (q.action) auditConds.push(eq(nbfcAuditLog.action_type, q.action));
    if (q.requestedBy) auditConds.push(eq(nbfcAuditLog.user_id, q.requestedBy));

    const auditRows = await db
      .select({
        id: nbfcAuditLog.id,
        created_at: nbfcAuditLog.created_at,
        action_type: nbfcAuditLog.action_type,
        action_id: nbfcAuditLog.action_id,
        before_state: nbfcAuditLog.before_state,
        after_state: nbfcAuditLog.after_state,
        user_id: nbfcAuditLog.user_id,
        user_name: usersTable.name,
        user_email: usersTable.email,
        user_role: nbfcUsers.role,
      })
      .from(nbfcAuditLog)
      .leftJoin(usersTable, eq(usersTable.id, nbfcAuditLog.user_id))
      .leftJoin(
        nbfcUsers,
        and(eq(nbfcUsers.user_id, nbfcAuditLog.user_id), eq(nbfcUsers.tenant_id, tenantId)),
      )
      .where(and(...auditConds))
      .orderBy(desc(nbfcAuditLog.created_at))
      .limit(500);

    // ── 2. nbfc_borrower_actions ────────────────────────────────────────────
    const baConds = [eq(nbfcBorrowerActions.tenant_id, tenantId)];
    if (from) baConds.push(gte(nbfcBorrowerActions.created_at, from));
    if (to) baConds.push(lte(nbfcBorrowerActions.created_at, to));
    if (q.action) baConds.push(eq(nbfcBorrowerActions.action_type, q.action));
    if (q.status) baConds.push(eq(nbfcBorrowerActions.status, q.status));
    if (q.requestedBy) baConds.push(eq(nbfcBorrowerActions.requested_by, q.requestedBy));
    if (q.entityId) baConds.push(ilike(nbfcBorrowerActions.loan_sanction_id, `%${q.entityId}%`));

    const baRows = await db
      .select({
        id: nbfcBorrowerActions.id,
        created_at: nbfcBorrowerActions.created_at,
        action_type: nbfcBorrowerActions.action_type,
        status: nbfcBorrowerActions.status,
        loan_sanction_id: nbfcBorrowerActions.loan_sanction_id,
        requested_by: nbfcBorrowerActions.requested_by,
        payload: nbfcBorrowerActions.payload,
        user_name: usersTable.name,
        user_email: usersTable.email,
        user_role: nbfcUsers.role,
      })
      .from(nbfcBorrowerActions)
      .leftJoin(usersTable, eq(usersTable.id, nbfcBorrowerActions.requested_by))
      .leftJoin(
        nbfcUsers,
        and(
          eq(nbfcUsers.user_id, nbfcBorrowerActions.requested_by),
          eq(nbfcUsers.tenant_id, tenantId),
        ),
      )
      .where(and(...baConds))
      .orderBy(desc(nbfcBorrowerActions.created_at))
      .limit(500);

    // ── 3. nbfc_immobilisation_actions ──────────────────────────────────────
    const imConds = [eq(nbfcImmobilisationActions.tenant_id, tenantId)];
    if (from) imConds.push(gte(nbfcImmobilisationActions.executed_at, from));
    if (to) imConds.push(lte(nbfcImmobilisationActions.executed_at, to));
    if (q.entityId)
      imConds.push(
        or(
          ilike(nbfcImmobilisationActions.loan_application_id, `%${q.entityId}%`),
          ilike(nbfcImmobilisationActions.imei, `%${q.entityId}%`),
        )!,
      );
    const includeImmob = !q.action || q.action === "battery_immobilisation";

    const imRows = includeImmob
      ? await db
          .select({
            id: nbfcImmobilisationActions.id,
            executed_at: nbfcImmobilisationActions.executed_at,
            imei: nbfcImmobilisationActions.imei,
            loan_application_id: nbfcImmobilisationActions.loan_application_id,
            approval_request_id: nbfcImmobilisationActions.approval_request_id,
            iot_command_id: nbfcImmobilisationActions.iot_command_id,
            borrower_notified_at: nbfcImmobilisationActions.borrower_notified_at,
          })
          .from(nbfcImmobilisationActions)
          .where(and(...imConds))
          .orderBy(desc(nbfcImmobilisationActions.executed_at))
          .limit(500)
      : [];

    // ── Normalise into the unified row shape ────────────────────────────────
    const items: AuditLogRow[] = [];

    for (const r of auditRows) {
      const after = (r.after_state ?? null) as Record<string, unknown> | null;
      const before = (r.before_state ?? null) as Record<string, unknown> | null;
      const loanId =
        (after && typeof after.loan_sanction_id === "string" ? after.loan_sanction_id : null) ??
        (before && typeof before.loan_sanction_id === "string" ? before.loan_sanction_id : null);
      const imei =
        (after && typeof after.imei === "string" ? after.imei : null) ??
        (before && typeof before.imei === "string" ? before.imei : null);
      const reasonText =
        (after && typeof after.reason === "string" ? after.reason : null) ??
        (after && typeof after.purpose === "string" ? after.purpose : null);

      if (q.status && typeof after?.status === "string" && after.status !== q.status) continue;
      if (q.entityId) {
        const needle = q.entityId.toLowerCase();
        const hay = `${loanId ?? ""} ${imei ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }

      items.push({
        id: `audit:${r.id}`,
        source: "audit_log",
        timestamp: r.created_at?.toISOString() ?? null,
        entity: inferEntity(r.action_type, after, loanId, imei),
        action: r.action_type,
        action_label: ACTION_LABELS[r.action_type] ?? r.action_type,
        reason_code: null,
        reason_text: reasonText,
        requested_by: {
          id: r.user_id,
          name: r.user_name ?? r.user_email ?? null,
          role: r.user_role ?? null,
        },
        approved_by: null,
        status: typeof after?.status === "string" ? after.status : "logged",
        before_state: before,
        after_state: after,
        borrower_notified_at: null,
        payload: null,
      });
    }

    for (const r of baRows) {
      const payload = (r.payload ?? null) as Record<string, unknown> | null;
      const ctx =
        payload && typeof payload.context === "object" && payload.context !== null
          ? (payload.context as Record<string, unknown>)
          : null;
      // Skip — already represented if a corresponding audit-log row was emitted
      // for the same action_id with full state. We keep the BA row only when no
      // audit row exists (pending/rejected actions that haven't completed).
      items.push({
        id: `ba:${r.id}`,
        source: "borrower_action",
        timestamp: r.created_at?.toISOString() ?? null,
        entity: inferEntity(r.action_type, payload, r.loan_sanction_id, null),
        action: r.action_type,
        action_label: ACTION_LABELS[r.action_type] ?? r.action_type,
        reason_code: typeof payload?.reason_code === "string" ? payload.reason_code : null,
        reason_text:
          (typeof payload?.reason === "string" ? payload.reason : null) ??
          (typeof ctx?.note === "string" ? ctx.note : null),
        requested_by: {
          id: r.requested_by,
          name: r.user_name ?? r.user_email ?? null,
          role: r.user_role ?? null,
        },
        approved_by: null,
        status: r.status,
        before_state: null,
        after_state: null,
        borrower_notified_at: null,
        payload,
      });
    }

    for (const r of imRows) {
      if (q.status && q.status !== "executed") continue;
      items.push({
        id: `im:${r.id}`,
        source: "immobilisation_action",
        timestamp: r.executed_at?.toISOString() ?? null,
        entity: { type: "battery", id: r.imei, label: r.imei },
        action: "battery_immobilisation",
        action_label: ACTION_LABELS.battery_immobilisation,
        reason_code: null,
        reason_text: null,
        requested_by: { id: null, name: null, role: null },
        approved_by: null,
        status: "executed",
        before_state: null,
        after_state: null,
        borrower_notified_at: r.borrower_notified_at?.toISOString() ?? null,
        payload: {
          loan_application_id: r.loan_application_id,
          approval_request_id: r.approval_request_id,
          iot_command_id: r.iot_command_id,
        },
      });
    }

    items.sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      return tb - ta;
    });

    const total = items.length;
    const start = (q.page - 1) * q.limit;
    const pageItems = items.slice(start, start + q.limit);

    // ── CSV export branch ───────────────────────────────────────────────────
    if (q.format === "csv") {
      const header = [
        "timestamp",
        "entity_type",
        "entity_id",
        "action",
        "status",
        "reason",
        "requested_by",
        "requested_by_role",
        "approved_by",
        "borrower_notified_at",
      ];
      const lines = [header.join(",")];
      for (const row of items) {
        lines.push(
          [
            csvCell(row.timestamp),
            csvCell(row.entity.type),
            csvCell(row.entity.id),
            csvCell(row.action),
            csvCell(row.status),
            csvCell(row.reason_text),
            csvCell(row.requested_by.name ?? row.requested_by.id),
            csvCell(row.requested_by.role),
            csvCell(row.approved_by?.name ?? row.approved_by?.id ?? ""),
            csvCell(row.borrower_notified_at),
          ].join(","),
        );
      }
      const csv = lines.join("\r\n");

      await db.insert(nbfcAuditLog).values({
        tenant_id: tenantId,
        user_id: actor.user_id,
        action_type: "audit_log_export",
        before_state: { exported: false },
        after_state: {
          exported: true,
          purpose: q.purpose,
          row_count: total,
          filters: {
            from: q.from ?? null,
            to: q.to ?? null,
            action: q.action ?? null,
            status: q.status ?? null,
            requestedBy: q.requestedBy ?? null,
            entityId: q.entityId ?? null,
          },
        },
      });

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="nbfc-audit-log-${stamp}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // ── JSON branch ─────────────────────────────────────────────────────────
    // Distinct users (for the user filter dropdown) — cheap aggregate over the
    // borrower-action + audit-log result set so the UI never has to round-trip.
    const requesterMap = new Map<string, { id: string; name: string | null; role: string | null }>();
    for (const r of baRows) {
      if (!r.requested_by) continue;
      if (!requesterMap.has(r.requested_by)) {
        requesterMap.set(r.requested_by, {
          id: r.requested_by,
          name: r.user_name ?? r.user_email ?? null,
          role: r.user_role ?? null,
        });
      }
    }
    for (const r of auditRows) {
      if (!r.user_id) continue;
      if (!requesterMap.has(r.user_id)) {
        requesterMap.set(r.user_id, {
          id: r.user_id,
          name: r.user_name ?? r.user_email ?? null,
          role: r.user_role ?? null,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      items: pageItems,
      page: q.page,
      page_size: q.limit,
      total,
      requesters: Array.from(requesterMap.values()),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

