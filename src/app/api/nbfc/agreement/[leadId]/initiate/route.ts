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
import { eq } from "drizzle-orm";

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
import { createLoanAgreementSignRequest } from "@/lib/digio/service";
import type { DigioSigner } from "@/lib/digio/mapper";
import { getNbfcObject } from "@/lib/nbfc/nbfc-storage";

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

    // Optional NBFC signatory co-signing (§17.3 — optional per operator choice).
    // When the operator opts in, they type the NBFC signer's name + email here;
    // when they don't, only the customer signs. The signer details are NOT
    // auto-pulled from the acting user — the operator enters whoever will sign.
    let nbfcSigns = true;
    let nbfcSignerName = "";
    let nbfcSignerEmail = "";
    // "Resend link": re-send the e-sign email for an already in-progress
    // agreement by re-issuing the sign request (Digio has no resend-only API).
    let resend = false;
    try {
      const body = (await req.json()) as {
        nbfc_signs?: boolean;
        nbfc_signer_name?: string;
        nbfc_signer_email?: string;
        resend?: boolean;
      } | null;
      if (body && typeof body.nbfc_signs === "boolean") nbfcSigns = body.nbfc_signs;
      if (body && typeof body.nbfc_signer_name === "string") nbfcSignerName = body.nbfc_signer_name.trim();
      if (body && typeof body.nbfc_signer_email === "string") nbfcSignerEmail = body.nbfc_signer_email.trim();
      if (body && typeof body.resend === "boolean") resend = body.resend;
    } catch {
      /* no/blank body — keep defaults */
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
    // opening duplicates (Digio docs are expensive to re-create). EXCEPTION:
    // an explicit "Resend link" on an in-progress agreement re-issues the
    // request so the customer's e-sign email is sent again. A signed attempt is
    // terminal — resend is ignored there.
    const latest = await getLatestAgreement(leadId, winner.nbfc_id);
    const allowResend = resend && latest?.status === "in_progress";
    if (latest && (latest.status === "in_progress" || latest.status === "signed") && !allowResend) {
      return NextResponse.json({
        ok: true,
        agreement_id: latest.id,
        status: latest.status,
        method: latest.method,
        digio_document_id: latest.digio_document_id,
        idempotent: true,
      });
    }

    // On resend, reuse the signer config we saved at first send (the in-progress
    // UI doesn't re-collect it). Legacy rows that predate this saved config fall
    // back to a CUSTOMER-ONLY re-send — the customer is the awaiting party, and
    // we can't recover an NBFC co-signer's email after the fact, so we must never
    // block the resend (or drop the customer's email) on a missing co-signer.
    if (allowResend) {
      const saved = (latest!.provider_raw_payload as
        | { _resend?: { nbfc_signs?: boolean; nbfc_signer_name?: string; nbfc_signer_email?: string } }
        | null)?._resend;
      const savedEmail = (saved?.nbfc_signer_email ?? "").trim();
      if (saved?.nbfc_signs && savedEmail) {
        nbfcSigns = true;
        nbfcSignerName = saved.nbfc_signer_name ?? "";
        nbfcSignerEmail = savedEmail;
      } else {
        nbfcSigns = false;
      }
    }

    // iTarang eSign on an NBFC-uploaded PDF (uploadpdf) when a source doc was
    // uploaded into the current pending row; otherwise fall back to the
    // pre-configured template path.
    const useUpload =
      method === "digio" && !!latest?.source_document_url && (latest?.status === "pending" || allowResend);
    // Re-issue against the SAME agreement row (keeps one attempt per agreement)
    // for both the uploadpdf path and any resend.
    const reuseRow = useUpload || allowResend;
    // On RESEND, mint a FRESH agreement ref so Digio treats it as a brand-new
    // sign request and re-sends the email — rather than potentially de-duping
    // against the prior request. The uploadpdf-from-pending path keeps its ref.
    const agreementRef = allowResend
      ? generateAgreementRef(leadId)
      : reuseRow && latest
        ? latest.agreement_ref
        : generateAgreementRef(leadId);
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
    let customerSigningUrl: string | null = null;
    const customerName = lead.full_name ?? lead.owner_name ?? "Customer";

    if (method === "digio") {
      const [me] = await db
        .select({ legal_name: nbfc.legal_name, short_name: nbfc.short_name })
        .from(nbfc)
        .where(eq(nbfc.id, winner.nbfc_id))
        .limit(1);

      if (useUpload) {
        // ── iTarang eSign on the NBFC-uploaded PDF (Digio uploadpdf) ────────
        const srcBuf = await getNbfcObject(latest!.source_document_url!);
        if (!srcBuf) {
          return NextResponse.json(
            { ok: false, error: "The uploaded agreement could not be read — please re-upload and try again." },
            { status: 502 },
          );
        }
        // Customer signs via Aadhaar eSign; the signing link is emailed to the
        // borrower, so the customer's email is the Digio identifier (required).
        const customerId = (lead.owner_email || "").trim();
        if (!customerId) {
          return NextResponse.json(
            { ok: false, error: "BAD_REQUEST: the customer has no email on file — add the customer's email before sending the agreement to e-sign" },
            { status: 400 },
          );
        }
        // Customer signs first; bottom-right (bottom-centre when signing alone).
        const signers: DigioSigner[] = [
          {
            identifier: customerId,
            name: customerName,
            reason: "Borrower, loan agreement",
            sign_type: "aadhaar",
            sign_coordinates: { page_no: 1, x: nbfcSigns ? 360 : 200, y: 780, w: 180, h: 50 },
          },
        ];
        // Optional NBFC signatory — the operator-entered signer signs second via
        // Aadhaar eSign; the link is emailed to the address they typed in.
        if (nbfcSigns) {
          if (!nbfcSignerEmail) {
            return NextResponse.json(
              { ok: false, error: "BAD_REQUEST: enter the NBFC signatory's email to co-sign (or send without NBFC co-signing)" },
              { status: 400 },
            );
          }
          signers.push({
            identifier: nbfcSignerEmail,
            name: nbfcSignerName || me?.legal_name || me?.short_name || "NBFC signatory",
            reason: "NBFC signatory",
            sign_type: "aadhaar",
            sign_coordinates: { page_no: 1, x: 60, y: 780, w: 180, h: 50 }, // bottom-left
          });
        }

        const resp = (await createLoanAgreementSignRequest({
          fileData: srcBuf.toString("base64"),
          fileName: `loan-agreement-${leadId}.pdf`,
          agreementRef,
          expireInDays: 14,
          signers,
        })) as {
          id?: string;
          document_id?: string;
          signing_parties?: Array<{ authentication_url?: string; authenticationUrl?: string }>;
        } & Record<string, unknown>;

        digioDocumentId = resp.id ?? resp.document_id ?? null;
        customerSigningUrl =
          resp.signing_parties?.[0]?.authentication_url ?? resp.signing_parties?.[0]?.authenticationUrl ?? null;
        providerRaw = resp;
        if (!digioDocumentId) {
          return NextResponse.json(
            { ok: false, error: "The e-Sign request could not be created — please try again shortly." },
            { status: 502 },
          );
        }
      } else {
        // ── Fallback: pre-configured template (no uploaded PDF) ─────────────
        const templateKey =
          process.env.NBFC_LOAN_AGREEMENT_DIGIO_TEMPLATE_KEY?.trim() ||
          process.env.DIGIO_TEMPLATE_ID?.trim();
        if (!templateKey) {
          return NextResponse.json(
            { ok: false, error: "BAD_REQUEST: upload an agreement PDF first (no eSign template configured)" },
            { status: 400 },
          );
        }
        const customerEmail = (lead.owner_email || "").trim();
        if (!customerEmail) {
          return NextResponse.json(
            { ok: false, error: "BAD_REQUEST: the customer has no email on file — add the customer's email before sending the agreement to e-sign" },
            { status: 400 },
          );
        }
        const tplSigners = [
          {
            identifier: customerEmail,
            name: customerName,
            reason: "Borrower, loan agreement",
            sign_type: "aadhaar" as const,
          },
        ];
        // Optional NBFC signatory — operator-entered, emailed via Aadhaar eSign.
        if (nbfcSigns) {
          if (!nbfcSignerEmail) {
            return NextResponse.json(
              { ok: false, error: "BAD_REQUEST: enter the NBFC signatory's email to co-sign (or send without NBFC co-signing)" },
              { status: 400 },
            );
          }
          tplSigners.push({
            identifier: nbfcSignerEmail,
            name: nbfcSignerName || me?.legal_name || me?.short_name || "NBFC signatory",
            reason: "NBFC signatory",
            sign_type: "aadhaar" as const,
          });
        }
        const resp = (await createMultiTemplateSignRequest({
          templates: [
            {
              template_key: templateKey,
              template_values: {
                customer_name: customerName,
                nbfc_legal_name: me?.legal_name ?? me?.short_name ?? "",
                lead_id: leadId,
                agreement_date: now.toISOString().slice(0, 10),
              },
            },
          ],
          signers: tplSigners,
          expire_in_days: 14,
          notify_signers: true,
          send_sign_link: true,
          generate_access_token: true,
          display_on_page: "all",
          sequence_type: "SEQUENTIAL",
          callback: `AGR_${agreementRef}`,
        })) as { id?: string; signing_parties?: Array<{ authentication_url?: string }> } & Record<string, unknown>;
        digioDocumentId = resp.id ?? null;
        customerSigningUrl = resp.signing_parties?.[0]?.authentication_url ?? null;
        providerRaw = resp;
        if (!digioDocumentId) {
          return NextResponse.json(
            { ok: false, error: "The e-Sign request could not be created — please try again shortly." },
            { status: 502 },
          );
        }
      }
    }

    // Persist the effective signer config alongside the raw Digio payload so a
    // later "Resend link" can faithfully re-issue (esp. the optional NBFC
    // co-signer, whose email Digio's response does not echo back).
    const persistedPayload = providerRaw
      ? {
          ...providerRaw,
          _resend: { nbfc_signs: nbfcSigns, nbfc_signer_name: nbfcSignerName, nbfc_signer_email: nbfcSignerEmail },
        }
      : null;

    // Persist: update the existing row (uploadpdf path or resend) or open a new one.
    if (reuseRow) {
      await db
        .update(nbfcLoanAgreements)
        .set({
          status: "in_progress",
          method,
          agreement_ref: agreementRef,
          digio_document_id: digioDocumentId,
          provider_raw_status: "sign_request_created",
          provider_raw_payload: persistedPayload,
          initiated_by: actor.user_id,
          initiated_at: now,
          updated_at: now,
        })
        .where(eq(nbfcLoanAgreements.id, latest!.id));
      return NextResponse.json({
        ok: true,
        agreement_id: latest!.id,
        agreement_ref: agreementRef,
        method,
        status: "in_progress",
        digio_document_id: digioDocumentId,
        customer_signing_url: customerSigningUrl,
        resent: allowResend,
      });
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
      customer_signing_url: customerSigningUrl,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
