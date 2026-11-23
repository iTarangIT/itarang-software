/**
 * POST /api/nbfc/agreement/[leadId]/upload — BRD Addendum V0.3.1 §17.
 *
 * The NBFC uploads the UNSIGNED loan-agreement PDF for the winning lead. We
 * store it in the private `nbfc-documents` bucket and stamp the URL onto a
 * `pending` nbfc_loan_agreements row; /initiate then hands it to iTarang eSign
 * for the customer (+ NBFC signatory) to sign.
 *
 * Role: operations or nbfc_admin (same as /initiate). PDF only, ≤ 15 MB.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcLoanAgreements, nbfcServiceConfig } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { hierarchyBlock } from "@/lib/nbfc/approval-hierarchy-http";
import { getWinningAssignment } from "@/lib/nbfc/enach";
import { generateAgreementRef, getLatestAgreement, type AgreementMethod } from "@/lib/nbfc/agreement";
import { resolveServiceOptIn } from "@/lib/nbfc/service-opt-in";
import { putNbfcObject } from "@/lib/nbfc/nbfc-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

function isPdf(buf: Buffer): boolean {
  // %PDF- magic header — file.type is client-supplied and untrustworthy.
  return buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    // E-387 — parent/child CIBIL approval hierarchy gate.
    const hierarchyBlocked = await hierarchyBlock(actor, leadId, "agreement");
    if (hierarchyBlocked) return hierarchyBlocked;
    if (actor.role !== "operations" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot upload the agreement; operations or nbfc_admin required` },
        { status: 403 },
      );
    }

    const winner = await getWinningAssignment(leadId);
    if (!winner) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no winning NBFC selected for this lead yet" }, { status: 400 });
    }
    if (winner.tenant_id !== actor.tenant_id) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN: lead's winning NBFC is a different tenant" }, { status: 403 });
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: expected multipart/form-data body" }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: file field is required" }, { status: 422 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: `BAD_REQUEST: file exceeds ${MAX_BYTES} bytes` }, { status: 413 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    if (!isPdf(buf)) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: only PDF files are accepted" }, { status: 415 });
    }

    // 23 Nov — `signed=1`: the NBFC uploads the ALREADY-SIGNED agreement (wet
    // sign / own platform). No iTarang e-sign runs; the row goes straight to
    // 'signed' with the uploaded PDF as the signed copy. Allowed from pending,
    // failed or an e-sign still in flight (customer signed on paper instead).
    const signedUpload = ["1", "true", "yes"].includes(String(form.get("signed") ?? "").toLowerCase());

    // Guard: don't replace the source once signing is in flight / done.
    const latest = await getLatestAgreement(leadId, winner.nbfc_id);
    if (signedUpload) {
      if (latest?.status === "signed") {
        return NextResponse.json(
          { ok: false, error: "BAD_REQUEST: the agreement is already signed for this lead" },
          { status: 400 },
        );
      }
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
      const now = new Date();
      const { url: signedUrl } = await putNbfcObject(
        `agreements/${leadId}/signed-upload-${now.getTime()}.pdf`,
        buf,
        "application/pdf",
      );
      // signed-pdf serves this cache key first, so the download works without
      // an eSign document id.
      await putNbfcObject(`agreements/${leadId}/signed.pdf`, buf, "application/pdf");
      const fields = {
        status: "signed",
        method: "upload",
        signed_document_url: signedUrl,
        provider_raw_status: "signed_copy_uploaded",
        failure_reason: null,
        signed_at: now,
        updated_at: now,
      };
      let agreementId: string;
      if (latest && latest.status !== "skipped") {
        await db.update(nbfcLoanAgreements).set(fields).where(eq(nbfcLoanAgreements.id, latest.id));
        agreementId = latest.id;
      } else {
        const [created] = await db
          .insert(nbfcLoanAgreements)
          .values({
            lead_id: leadId,
            nbfc_id: winner.nbfc_id,
            tenant_id: actor.tenant_id,
            agreement_ref: generateAgreementRef(leadId),
            store_loan_agreement: true,
            initiated_by: actor.user_id,
            initiated_at: now,
            ...fields,
          })
          .returning({ id: nbfcLoanAgreements.id });
        agreementId = created.id;
      }
      try {
        const { notifyLoanAgreementEvent } = await import("@/lib/notifications/events");
        const { tenantDisplayName } = await import("@/lib/notifications/emit");
        await notifyLoanAgreementEvent({
          leadId,
          event: "signed",
          nbfcName: await tenantDisplayName(actor.tenant_id),
          tenantId: actor.tenant_id,
        });
      } catch (err) {
        console.error("[agreement/upload] signed notification failed:", err);
      }
      return NextResponse.json({ ok: true, agreement_id: agreementId, signed: true, size: file.size });
    }
    if (latest && (latest.status === "in_progress" || latest.status === "signed")) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: an agreement is already in progress or signed — cannot replace the source PDF" },
        { status: 400 },
      );
    }

    // Mechanism is read LIVE ("Not through iTarang" removes the rail); storage
    // opt-in stays snapshot-first (a per-lead promise to the customer).
    const snap = (winner.snapshot ?? {}) as {
      store_sanction_letter?: boolean;
      store_loan_agreement?: boolean;
    };
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
    let storeSanction = snap.store_sanction_letter ?? false;
    let storeLoan = snap.store_loan_agreement ?? false;
    if (snap.store_sanction_letter === undefined || snap.store_loan_agreement === undefined) {
      const [cfg] = await db
        .select({
          s: nbfcServiceConfig.store_sanction_letter,
          l: nbfcServiceConfig.store_loan_agreement,
        })
        .from(nbfcServiceConfig)
        .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
        .limit(1);
      storeSanction = snap.store_sanction_letter ?? cfg?.s ?? false;
      storeLoan = snap.store_loan_agreement ?? cfg?.l ?? false;
    }

    const now = new Date();
    const key = `agreements/${leadId}/source-${now.getTime()}.pdf`;
    const { url: sourceUrl } = await putNbfcObject(key, buf, "application/pdf");

    let agreementId: string;
    if (latest && latest.status === "pending") {
      await db
        .update(nbfcLoanAgreements)
        .set({ source_document_url: sourceUrl, method: method ?? latest.method, updated_at: now })
        .where(eq(nbfcLoanAgreements.id, latest.id));
      agreementId = latest.id;
    } else {
      const [created] = await db
        .insert(nbfcLoanAgreements)
        .values({
          lead_id: leadId,
          nbfc_id: winner.nbfc_id,
          tenant_id: actor.tenant_id,
          agreement_ref: generateAgreementRef(leadId),
          method: method ?? "digio",
          status: "pending",
          source_document_url: sourceUrl,
          provider_raw_status: "source_uploaded",
          store_sanction_letter: storeSanction,
          store_loan_agreement: storeLoan,
          initiated_by: actor.user_id,
          updated_at: now,
        })
        .returning({ id: nbfcLoanAgreements.id });
      agreementId = created.id;
    }

    return NextResponse.json({ ok: true, agreement_id: agreementId, source_document_url: sourceUrl, size: file.size });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
