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
import { nbfcLoanAgreements } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getWinningAssignment } from "@/lib/nbfc/enach";
import { getLatestAgreement } from "@/lib/nbfc/agreement";
import { getNbfcObject, putNbfcObject } from "@/lib/nbfc/nbfc-storage";
import { getDigioBaseUrl, getDigioBasicAuth } from "@/lib/digio/client";

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

async function tryDigioDownload(url: string, authHeader: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: authHeader, Accept: "application/pdf, application/octet-stream, */*" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) return null;
    const ab = await res.arrayBuffer();
    if (!isValidPdfBuffer(ab)) return null;
    return Buffer.from(ab);
  } catch (err) {
    console.warn("[agreement/audit-trail] network error", { err: err instanceof Error ? err.message : String(err) });
    return null;
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

    if (!pdf) {
      const authHeader = getDigioBasicAuth();
      if (!authHeader) {
        return NextResponse.json({ ok: false, error: "eSign provider is not configured (contact iTarang support)" }, { status: 500 });
      }
      const baseUrl = getDigioBaseUrl();
      const url = baseUrl + AUDIT_TRAIL_PATH.replace("{documentId}", encodeURIComponent(row.digio_document_id));
      pdf = await tryDigioDownload(url, authHeader);
    }

    if (!pdf) {
      return NextResponse.json(
        { ok: false, error: "Could not retrieve the audit trail yet — please try again shortly." },
        { status: 502 },
      );
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
