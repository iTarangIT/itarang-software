/**
 * POST /api/nbfc/agreement/[leadId]/initiate
 *
 * BRD Addendum V0.2 §11.3 — start the loan-agreement signing for the WINNING
 * NBFC, by the method configured in Document Handling (§7.4):
 *   - digio         → create a Digio sign request (customer + NBFC signatory),
 *                     store digio_document_id, status in_progress. The Digio
 *                     loan-agreement webhook later flips it to signed.
 *   - upload        → open an attempt in_progress; the signed copy is attached
 *                     via record-manual (signed_document_url).
 *   - api_autofetch → open an attempt in_progress (stub fetch placeholder).
 *
 * Per §11.5 the signed agreement is NOT a disbursal gate (Step-5 OTP is), so
 * this never blocks sanction. Role: operations or nbfc_admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { desc, eq, and } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  leads,
  nbfc,
  nbfcLoanAgreements,
  nbfcServiceConfig,
} from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getWinningAssignment } from "@/lib/nbfc/enach";
import {
  generateAgreementRef,
  getLatestAgreement,
  type AgreementMethod,
} from "@/lib/nbfc/agreement";
import { createMultiTemplateSignRequest } from "@/lib/digio/multi-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    if (actor.role !== "operations" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot initiate the agreement; operations or nbfc_admin required` },
        { status: 403 },
      );
    }

    // Agreement runs for the winning NBFC only (Stage 2, with E-NACH).
    const winner = await getWinningAssignment(leadId);
    if (!winner) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no winning NBFC selected for this lead yet" },
        { status: 400 },
      );
    }
    if (winner.tenant_id !== actor.tenant_id) {
      return NextResponse.json(
        { ok: false, error: "FORBIDDEN: lead's winning NBFC is a different tenant" },
        { status: 403 },
      );
    }

    // Resolve the signing mechanism: snapshot first (§7.4), then live config.
    const snap = (winner.snapshot ?? {}) as {
      doc_agreement_method?: AgreementMethod | null;
      store_sanction_letter?: boolean;
      store_loan_agreement?: boolean;
    };
    let method: AgreementMethod | null = snap.doc_agreement_method ?? null;
    let storeSanction = snap.store_sanction_letter ?? false;
    let storeLoan = snap.store_loan_agreement ?? false;
    if (!method) {
      const [cfg] = await db
        .select({
          m: nbfcServiceConfig.doc_agreement_method,
          s: nbfcServiceConfig.store_sanction_letter,
          l: nbfcServiceConfig.store_loan_agreement,
        })
        .from(nbfcServiceConfig)
        .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
        .limit(1);
      method = (cfg?.m ?? null) as AgreementMethod | null;
      storeSanction = cfg?.s ?? false;
      storeLoan = cfg?.l ?? false;
    }
    if (!method) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no agreement method configured in Settings → Document Handling" },
        { status: 400 },
      );
    }

    // Idempotency — if a non-terminal attempt exists, return it instead of
    // opening duplicates (Digio docs are expensive to re-create).
    const latest = await getLatestAgreement(leadId, winner.nbfc_id);
    if (latest && (latest.status === "in_progress" || latest.status === "signed")) {
      return NextResponse.json({
        ok: true,
        agreement_id: latest.id,
        status: latest.status,
        method: latest.method,
        digio_document_id: latest.digio_document_id,
        idempotent: true,
      });
    }

    const agreementRef = generateAgreementRef(leadId);
    const now = new Date();

    // Customer + NBFC context for the signing request.
    const [lead] = await db
      .select({
        full_name: leads.full_name,
        owner_name: leads.owner_name,
        owner_email: leads.owner_email,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: lead not found" }, { status: 404 });
    }

    let digioDocumentId: string | null = null;
    let providerRaw: Record<string, unknown> | null = null;

    if (method === "digio") {
      const [me] = await db
        .select({ legal_name: nbfc.legal_name, short_name: nbfc.short_name })
        .from(nbfc)
        .where(eq(nbfc.id, winner.nbfc_id))
        .limit(1);
      const templateKey =
        process.env.NBFC_LOAN_AGREEMENT_DIGIO_TEMPLATE_KEY?.trim() ||
        process.env.DIGIO_TEMPLATE_ID?.trim();
      if (!templateKey) {
        return NextResponse.json(
          { ok: false, error: "BAD_REQUEST: NBFC_LOAN_AGREEMENT_DIGIO_TEMPLATE_KEY (or DIGIO_TEMPLATE_ID) is not configured" },
          { status: 400 },
        );
      }
      const customerEmail = (lead.owner_email || "").trim();
      if (!customerEmail) {
        return NextResponse.json(
          { ok: false, error: "BAD_REQUEST: customer email required for Digio e-sign" },
          { status: 400 },
        );
      }
      const resp = await createMultiTemplateSignRequest({
        templates: [
          {
            template_key: templateKey,
            template_values: {
              customer_name: lead.full_name ?? lead.owner_name ?? "",
              nbfc_legal_name: me?.legal_name ?? me?.short_name ?? "",
              lead_id: leadId,
              agreement_date: now.toISOString().slice(0, 10),
            },
          },
        ],
        signers: [
          {
            identifier: customerEmail,
            name: lead.full_name ?? lead.owner_name ?? "Customer",
            reason: "Borrower, loan agreement",
            sign_type: "aadhaar",
          },
        ],
        sequential: true,
        expire_in_days: 14,
        notify_signers: true,
        customer_notification_mode: "all",
        // Routed to the loan-agreement webhook by the AGR_ callback prefix.
        callback: `AGR_${agreementRef}`,
      });
      digioDocumentId = resp.id ?? null;
      providerRaw = resp as unknown as Record<string, unknown>;
      if (!digioDocumentId) {
        return NextResponse.json(
          { ok: false, error: "Digio create_sign_request returned no document id" },
          { status: 502 },
        );
      }
    }

    const [created] = await db
      .insert(nbfcLoanAgreements)
      .values({
        lead_id: leadId,
        nbfc_id: winner.nbfc_id,
        tenant_id: actor.tenant_id,
        agreement_ref: agreementRef,
        method,
        status: "in_progress",
        digio_document_id: digioDocumentId,
        provider_raw_status: method === "digio" ? "sign_request_created" : "awaiting_upload",
        provider_raw_payload: providerRaw,
        store_sanction_letter: storeSanction,
        store_loan_agreement: storeLoan,
        initiated_by: actor.user_id,
        initiated_at: now,
        updated_at: now,
      })
      .returning({ id: nbfcLoanAgreements.id });

    return NextResponse.json({
      ok: true,
      agreement_id: created.id,
      agreement_ref: agreementRef,
      method,
      status: "in_progress",
      digio_document_id: digioDocumentId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
