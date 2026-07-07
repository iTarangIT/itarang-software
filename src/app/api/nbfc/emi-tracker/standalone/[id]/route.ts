/**
 * PATCH  /api/nbfc/emi-tracker/standalone/[id]
 * DELETE /api/nbfc/emi-tracker/standalone/[id]
 *
 * Edit or remove a STANDALONE EMI Tracker entry (E-183) — a bulk-upload row
 * that had no matching loan and was force-imported as a display-only tracker
 * record. Unlike the per-loan tracker-override (which COALESCEs override →
 * computed), a standalone row has no loan/schedule to fall back to, so every
 * value shown IS the row's own value — PATCH stores the fields as given.
 *
 * Scoped to the current tenant AND to is_standalone rows only, so this can never
 * touch a real per-loan override. DELETE removes the row entirely (there's no
 * computed value to revert to). Audit-logged.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { clientError } from "@/lib/nbfc/http-error";
import { nbfcAuditLog, nbfcEmiTrackerOverrides } from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { SYSTEM_USER_ID } from "@/lib/nbfc/servicing/applyEmiPayment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_STATUS = new Set(["active", "overdue", "closed"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function optText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function optNum(v: unknown, label: string): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`BAD_REQUEST: ${label} must be a number`);
  return n;
}
function optDate(v: unknown, label: string): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!DATE_RE.test(s) || Number.isNaN(new Date(`${s}T00:00:00.000Z`).getTime())) {
    throw new Error(`BAD_REQUEST: ${label} must be YYYY-MM-DD`);
  }
  return s;
}

async function resolveTenantRow(id: string) {
  const tenant = await getCurrentTenant();
  const session = await requireNbfcAccess(tenant.id);
  const actorUserId = "id" in session ? session.id : SYSTEM_USER_ID;
  const [row] = await db
    .select({ id: nbfcEmiTrackerOverrides.id })
    .from(nbfcEmiTrackerOverrides)
    .where(
      and(
        eq(nbfcEmiTrackerOverrides.id, id),
        eq(nbfcEmiTrackerOverrides.tenant_id, tenant.id),
        eq(nbfcEmiTrackerOverrides.is_standalone, true),
      ),
    )
    .limit(1);
  return { tenant, actorUserId, exists: Boolean(row) };
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!id) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: id required" }, { status: 400 });
    }
    const { tenant, actorUserId, exists } = await resolveTenantRow(id);
    if (!exists) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: standalone row not found for this tenant" }, { status: 404 });
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON body" }, { status: 400 });
    }

    const status = optText(body.status);
    if (status != null && !ALLOWED_STATUS.has(status)) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: status must be active|overdue|closed" }, { status: 400 });
    }

    const values = {
      borrower: optText(body.borrower),
      vehicleno: optText(body.vehicleno),
      emi: (() => {
        const n = optNum(body.emi, "emi");
        return n == null ? null : n.toFixed(2);
      })(),
      next_due: optDate(body.next_due, "next_due"),
      last_paid: optDate(body.last_paid, "last_paid"),
      progress_paid: optNum(body.progress_paid, "progress_paid"),
      progress_total: optNum(body.progress_total, "progress_total"),
      status,
      dpd: optNum(body.dpd, "dpd"),
      mandate: optText(body.mandate),
      next_auto_debit: optDate(body.next_auto_debit, "next_auto_debit"),
      financier: optText(body.financier),
      updated_by: actorUserId,
      updated_at: new Date(),
    };

    await db.transaction(async (tx) => {
      await tx
        .update(nbfcEmiTrackerOverrides)
        .set(values)
        .where(
          and(
            eq(nbfcEmiTrackerOverrides.id, id),
            eq(nbfcEmiTrackerOverrides.tenant_id, tenant.id),
            eq(nbfcEmiTrackerOverrides.is_standalone, true),
          ),
        );
      await tx.insert(nbfcAuditLog).values({
        tenant_id: tenant.id,
        user_id: actorUserId,
        action_type: "emi_tracker_edit",
        action_id: id,
        after_state: { standalone_id: id, standalone: true, values },
      });
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("BAD_REQUEST")
      ? 400
      : msg.includes("FORBIDDEN") || msg.includes("not allowed")
        ? 403
        : msg.startsWith("UNAUTHORIZED")
          ? 401
          : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!id) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: id required" }, { status: 400 });
    }
    const { tenant, actorUserId, exists } = await resolveTenantRow(id);
    if (!exists) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: standalone row not found for this tenant" }, { status: 404 });
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(nbfcEmiTrackerOverrides)
        .where(
          and(
            eq(nbfcEmiTrackerOverrides.id, id),
            eq(nbfcEmiTrackerOverrides.tenant_id, tenant.id),
            eq(nbfcEmiTrackerOverrides.is_standalone, true),
          ),
        );
      await tx.insert(nbfcAuditLog).values({
        tenant_id: tenant.id,
        user_id: actorUserId,
        action_type: "emi_tracker_edit",
        action_id: id,
        after_state: { standalone_id: id, standalone: true, removed: true },
      });
    });

    return NextResponse.json({ ok: true, removed: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.includes("FORBIDDEN") || msg.includes("not allowed")
      ? 403
      : msg.startsWith("UNAUTHORIZED")
        ? 401
        : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status });
  }
}
