/**
 * POST /api/nbfc/agreement/[leadId]/record-manual
 *
 * BRD Addendum V0.2 §11 — fallback / upload path. Records the agreement outcome
 * (signed / failed) against the latest attempt, or opens a fresh one. For the
 * "upload signed copy" method this carries the signed_document_url. Storage is
 * optional (§11.4): a URL is only stored when the NBFC opted in; otherwise we
 * keep the §11.6 audit record (loan-exists flag) with no PDF.
 *
 * Role: operations or nbfc_admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcLoanAgreements, nbfcServiceConfig } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getWinningAssignment } from "@/lib/nbfc/enach";
import {
  generateAgreementRef,
  getLatestAgreement,
  type AgreementMethod,
} from "@/lib/nbfc/agreement";
import { resolveServiceOptIn } from "@/lib/nbfc/service-opt-in";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  status: z.enum(["signed", "failed"]),
  signed_document_url: z.string().max(2048).nullable().optional(),
  audit_trail_url: z.string().max(2048).nullable().optional(),
  failure_reason: z.string().max(1000).nullable().optional(),
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
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot record the agreement; operations or nbfc_admin required` },
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

    // The agreement rail can be switched off entirely (Settings → Document
    // Handling → "Not through iTarang"), in which case there is nothing to
    // record here — the NBFC keeps the paperwork on its own systems.
    // Storage opt-in — §11.4. A signed-copy URL is retained only when the NBFC
    // allows it; otherwise we keep the §11.6 audit record without the PDF.
    const snap = (winner.snapshot ?? {}) as {
      store_loan_agreement?: boolean;
    };
    let storeLoan = snap.store_loan_agreement ?? false;
    const method: AgreementMethod | null = (
      await resolveServiceOptIn(actor.tenant_id, winner.snapshot)
    ).doc_agreement_method;
    if (!method) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "BAD_REQUEST: the loan agreement does not run through iTarang for this NBFC (Settings -> Document Handling) - handled off-platform",
        },
        { status: 400 },
      );
    }
    if (snap.store_loan_agreement === undefined) {
      const [cfg] = await db
        .select({ l: nbfcServiceConfig.store_loan_agreement })
        .from(nbfcServiceConfig)
        .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
        .limit(1);
      storeLoan = cfg?.l ?? false;
    }

    const d = parsed.data;
    const now = new Date();
    const latest = await getLatestAgreement(leadId, winner.nbfc_id);

    const fields = {
      status: d.status,
      // §11.4 — only retain the PDF URL when storage is opted in.
      signed_document_url:
        d.status === "signed" && storeLoan
          ? d.signed_document_url ?? latest?.signed_document_url ?? null
          : latest?.signed_document_url ?? null,
      audit_trail_url:
        d.status === "signed" && storeLoan
          ? d.audit_trail_url ?? latest?.audit_trail_url ?? null
          : latest?.audit_trail_url ?? null,
      provider_raw_status: "manual",
      failure_reason: d.failure_reason ?? (d.status === "failed" ? "Recorded failed (manual)" : null),
      signed_at: d.status === "signed" ? now : latest?.signed_at ?? null,
      updated_at: now,
    };

    if (latest && latest.status === "in_progress") {
      await db.update(nbfcLoanAgreements).set(fields).where(eq(nbfcLoanAgreements.id, latest.id));
      return NextResponse.json({ ok: true, agreement_id: latest.id, stored_pdf: !!fields.signed_document_url });
    }

    const [created] = await db
      .insert(nbfcLoanAgreements)
      .values({
        lead_id: leadId,
        nbfc_id: winner.nbfc_id,
        tenant_id: actor.tenant_id,
        agreement_ref: generateAgreementRef(leadId),
        method: method ?? "upload",
        store_loan_agreement: storeLoan,
        initiated_by: actor.user_id,
        initiated_at: now,
        ...fields,
      })
      .returning({ id: nbfcLoanAgreements.id });
    return NextResponse.json({ ok: true, agreement_id: created.id, stored_pdf: !!fields.signed_document_url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
