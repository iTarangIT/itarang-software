/**
 * GET /api/nbfc/agreement/[leadId]
 *
 * BRD Addendum V0.2 §11 — agreement state for a lead's winning NBFC: the
 * advisory gate (§11.5 — NOT a disbursal gate) plus the full attempt history
 * (latest first) and RBAC flags. Mirrors the E-NACH status GET shape.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, nbfcLoanAgreements, nbfcServiceConfig } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getWinningAssignment } from "@/lib/nbfc/enach";
import { evaluateAgreementGate, type AgreementMethod } from "@/lib/nbfc/agreement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  return 500;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);

    const winner = await getWinningAssignment(leadId);
    const isOurs = !!winner && winner.tenant_id === actor.tenant_id;

    // The signing mechanism comes from the per-lead snapshot first (so an
    // in-flight lead is unaffected by later edits), falling back to live config.
    const snap = (winner?.snapshot ?? {}) as { doc_agreement_method?: AgreementMethod | null };
    let method: AgreementMethod | null = snap.doc_agreement_method ?? null;
    if (!method && isOurs) {
      const [cfg] = await db
        .select({ m: nbfcServiceConfig.doc_agreement_method })
        .from(nbfcServiceConfig)
        .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
        .limit(1);
      method = (cfg?.m ?? null) as AgreementMethod | null;
    }

    const gate = await evaluateAgreementGate(
      leadId,
      isOurs ? winner!.nbfc_id : null,
      method,
    );

    // Surface the customer's email so the panel can confirm where the
    // Aadhaar-eSign agreement link will be sent (it's emailed to the borrower).
    const [lead] = await db
      .select({ owner_email: leads.owner_email })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    const customerEmail = (lead?.owner_email || "").trim() || null;

    let attempts: unknown[] = [];
    if (isOurs) {
      attempts = await db
        .select()
        .from(nbfcLoanAgreements)
        .where(
          and(
            eq(nbfcLoanAgreements.lead_id, leadId),
            eq(nbfcLoanAgreements.nbfc_id, winner!.nbfc_id),
          ),
        )
        .orderBy(desc(nbfcLoanAgreements.created_at));
    }

    return NextResponse.json({
      ok: true,
      gate,
      method,
      customer_email: customerEmail,
      attempt_count: attempts.length,
      attempts,
      // Operations/admin own initiation + manual recording (§7.2, same as E-NACH).
      can_act: actor.role === "operations" || actor.role === "nbfc_admin",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
