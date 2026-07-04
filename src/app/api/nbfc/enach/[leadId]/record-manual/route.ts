/**
 * POST /api/nbfc/enach/[leadId]/record-manual
 *
 * BRD Addendum V0.2 §9.4 — "Record Result Manually" fallback when the NBFC
 * callback isn't wired. Records the mandate outcome (UMRN, status, bank, …)
 * against the latest attempt, or opens a fresh manual attempt if none exists.
 *
 * Role: `operations` or `nbfc_admin`.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { enachMandates } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { generateEnachRef, getLatestMandate, getWinningAssignment } from "@/lib/nbfc/enach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  status: z.enum(["registered", "failed", "in_progress"]),
  umrn: z.string().max(64).nullable().optional(),
  bank_name: z.string().max(120).nullable().optional(),
  account_masked: z.string().max(64).nullable().optional(),
  max_amount: z.union([z.number(), z.string()]).nullable().optional(),
  valid_from: z.string().nullable().optional(),
  valid_to: z.string().nullable().optional(),
  provider_name: z.string().max(80).nullable().optional(),
  provider_raw_status: z.string().max(120).nullable().optional(),
  proof_url: z.string().max(2048).nullable().optional(),
  failure_reason: z.string().nullable().optional(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }

    const actor = await resolveActor(req.headers);
    if (actor.role !== "operations" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot record E-NACH; operations or nbfc_admin required` },
        { status: 403 },
      );
    }

    const winner = await getWinningAssignment(leadId);
    if (!winner || winner.tenant_id !== actor.tenant_id) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no winning NBFC for this lead under this tenant" },
        { status: 400 },
      );
    }

    const d = parsed.data;
    const maxAmount = d.max_amount == null ? null : String(d.max_amount);
    const now = new Date();
    const latest = await getLatestMandate(leadId, winner.nbfc_id);

    const fields = {
      status: d.status,
      umrn: d.umrn ?? latest?.umrn ?? null,
      bank_name: d.bank_name ?? latest?.bank_name ?? null,
      account_masked: d.account_masked ?? latest?.account_masked ?? null,
      max_amount: maxAmount ?? latest?.max_amount ?? null,
      valid_from: d.valid_from ?? latest?.valid_from ?? null,
      valid_to: d.valid_to ?? latest?.valid_to ?? null,
      provider_name: d.provider_name ?? latest?.provider_name ?? null,
      provider_raw_status: d.provider_raw_status ?? null,
      registration_method: "manual" as const,
      proof_url: d.proof_url ?? latest?.proof_url ?? null,
      failure_reason: d.failure_reason ?? (d.status === "failed" ? "Recorded failed (manual)" : null),
      registered_at: d.status === "registered" ? now : latest?.registered_at ?? null,
      updated_at: now,
    };

    // Update an in-flight attempt; otherwise open a fresh manual attempt.
    if (latest && (latest.status === "in_progress" || latest.status === "pending")) {
      await db.update(enachMandates).set(fields).where(eq(enachMandates.id, latest.id));
      return NextResponse.json({ ok: true, mandate_id: latest.id });
    }

    const [created] = await db
      .insert(enachMandates)
      .values({
        lead_id: leadId,
        nbfc_id: winner.nbfc_id,
        tenant_id: actor.tenant_id,
        enach_ref: generateEnachRef(leadId),
        registration_date: now,
        triggered_by: actor.user_id,
        triggered_at: now,
        ...fields,
      })
      .returning({ id: enachMandates.id });
    return NextResponse.json({ ok: true, mandate_id: created.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
