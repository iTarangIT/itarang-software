/**
 * GET /api/nbfc/agreement/[leadId]/audit-trail — BRD Addendum V0.3.1 §17.
 *
 * On-demand proxy for the borrower loan-agreement audit-trail PDF. Mirrors the
 * NBFC LSP audit-trail proxy. Storage optional (§17.4): cache + stamp only when
 * the NBFC opted in; otherwise fetch live and stream. Role: operations / nbfc_admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, nbfc, nbfcLoanAgreements } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getWinningAssignment } from "@/lib/nbfc/enach";
import { getLatestAgreement } from "@/lib/nbfc/agreement";
import { getNbfcObject, putNbfcObject } from "@/lib/nbfc/nbfc-storage";
import { getDigioBaseUrl, getDigioBasicAuth } from "@/lib/digio/client";
import { generateAgreementAuditPdf } from "@/lib/nbfc/agreement-audit-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUDIT_TRAIL_PATH =
  process.env.DIGIO_AUDIT_TRAIL_PATH_TEMPLATE ||
  "/v2/client/document/download_audit_trail?document_id={documentId}";

function isValidPdfBuffer(buffer: ArrayBuffer | Buffer | null): boolean {
  if (!buffer) return false;
  const view = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer);
  if (view.byteLength < 500) return false;
  return view[0] === 0x25 && view[1] === 0x50 && view[2] === 0x44 && view[3] === 0x46 && view[4] === 0x2d;
}

async function tryDigioDownload(url: string, authHeader: string): Promise<{ pdf: Buffer | null; diag: string }> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: authHeader, Accept: "application/pdf, application/octet-stream, */*" },
      cache: "no-store",
    });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok) {
      let body = "";
      try { body = (await res.text()).slice(0, 300); } catch { /* ignore */ }
      return { pdf: null, diag: `HTTP ${res.status} (${ct || "no content-type"}) ${body}`.trim() };
    }
    if (ct.includes("json")) {
      let body = "";
      try { body = (await res.text()).slice(0, 300); } catch { /* ignore */ }
      return { pdf: null, diag: `Digio returned JSON: ${body}` };
    }
    const ab = await res.arrayBuffer();
    if (!isValidPdfBuffer(ab)) {
      return { pdf: null, diag: `Non-PDF body (${ab.byteLength} bytes, content-type=${ct || "none"})` };
    }
    return { pdf: Buffer.from(ab), diag: "ok" };
  } catch (err) {
    return { pdf: null, diag: `network error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    if (actor.role !== "operations" && actor.role !== "nbfc_admin") {
      return NextResponse.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
    }
    const winner = await getWinningAssignment(leadId);
    if (!winner || winner.tenant_id !== actor.tenant_id) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
    }

    const row = await getLatestAgreement(leadId, winner.nbfc_id);
    if (!row || row.status !== "signed") {
      return NextResponse.json({ ok: false, error: "Agreement is not yet signed" }, { status: 400 });
    }
    if (!row.digio_document_id) {
      return NextResponse.json({ ok: false, error: "Agreement has no eSign document on file" }, { status: 400 });
    }

    const cacheKey = `agreements/${leadId}/audit-trail.pdf`;

    let pdf = await getNbfcObject(cacheKey);
    if (pdf && !isValidPdfBuffer(pdf)) pdf = null;

    let diag = "served from cache";
    if (!pdf) {
      const authHeader = getDigioBasicAuth();
      if (!authHeader) {
        return NextResponse.json({ ok: false, error: "eSign provider is not configured (contact iTarang support)" }, { status: 500 });
      }
      const baseUrl = getDigioBaseUrl();
      const url = baseUrl + AUDIT_TRAIL_PATH.replace("{documentId}", encodeURIComponent(row.digio_document_id));
      const r = await tryDigioDownload(url, authHeader);
      pdf = r.pdf;
      diag = r.diag;
      if (!pdf) console.warn("[agreement/audit-trail] fetch failed", { path: AUDIT_TRAIL_PATH, diag });
    }

    if (!pdf) {
      // No provider audit certificate available — the agreement was recorded
      // signed manually (no provider e-sign), or the provider document lives in
      // a different environment (ENTITY_NOT_FOUND). Rather than fail, generate
      // iTarang's own audit record so the operator always gets a document (§17.6).
      console.warn("[agreement/audit-trail] provider trail unavailable; serving iTarang audit record", { diag });
      const [leadRow] = await db
        .select({ full_name: leads.full_name, owner_name: leads.owner_name, owner_email: leads.owner_email })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
      const [me] = await db
        .select({ legal_name: nbfc.legal_name, short_name: nbfc.short_name })
        .from(nbfc)
        .where(eq(nbfc.id, winner.nbfc_id))
        .limit(1);
      const customerName = leadRow?.full_name || leadRow?.owner_name || "Customer";
      const customerEmail = leadRow?.owner_email ?? null;
      const saved = (row.provider_raw_payload as
        | { _resend?: { nbfc_signs?: boolean; nbfc_signer_name?: string; nbfc_signer_email?: string } }
        | null)?._resend;
      const signers: Array<{ name: string; email: string | null }> = [{ name: customerName, email: customerEmail }];
      if (saved?.nbfc_signs && (saved.nbfc_signer_email || saved.nbfc_signer_name)) {
        signers.push({ name: saved.nbfc_signer_name || "NBFC signatory", email: saved.nbfc_signer_email || null });
      }
      const fallback = await generateAgreementAuditPdf({
        leadId,
        agreementRef: row.agreement_ref,
        nbfcName: me?.legal_name || me?.short_name || "",
        customerName,
        customerEmail,
        status: row.status,
        initiatedAt: row.initiated_at ? new Date(row.initiated_at) : null,
        signedAt: row.signed_at ? new Date(row.signed_at) : null,
        signers,
        generatedAt: new Date(),
      });
      return new NextResponse(new Uint8Array(fallback), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="loan-audit-record-${leadId}.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (row.store_loan_agreement) {
      try {
        const { url } = await putNbfcObject(cacheKey, pdf, "application/pdf");
        if (row.audit_trail_url !== url) {
          await db.update(nbfcLoanAgreements).set({ audit_trail_url: url, updated_at: new Date() }).where(eq(nbfcLoanAgreements.id, row.id));
        }
      } catch (err) {
        console.warn("[agreement/audit-trail] cache/stamp failed", { err: err instanceof Error ? err.message : String(err) });
      }
    }

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="loan-audit-trail-${leadId}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.startsWith("UNAUTHORIZED") ? 401 : msg.startsWith("FORBIDDEN") ? 403 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status: code });
  }
}
