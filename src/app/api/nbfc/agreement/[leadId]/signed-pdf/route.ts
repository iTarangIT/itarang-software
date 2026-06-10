/**
 * GET /api/nbfc/agreement/[leadId]/signed-pdf — BRD Addendum V0.3.1 §17.
 *
 * On-demand proxy that streams the signed borrower loan-agreement PDF to the
 * browser. Mirrors the working NBFC LSP signed-pdf proxy. Storage is optional
 * (§17.4): we cache + stamp the URL ONLY when the NBFC opted in; otherwise we
 * fetch live from the eSign provider on each request and stream without
 * persisting.
 *
 * Fallback chain: bucket cache → provider direct-query → direct-path → status
 * JSON + extracted URL. Role: operations or nbfc_admin (tenant-scoped).
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcLoanAgreements } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getWinningAssignment } from "@/lib/nbfc/enach";
import { getLatestAgreement } from "@/lib/nbfc/agreement";
import { getNbfcObject, putNbfcObject } from "@/lib/nbfc/nbfc-storage";
import { getDigioBaseUrl, getDigioBasicAuth } from "@/lib/digio/client";
import { extractSignedAgreementUrl } from "@/lib/digio/parse-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidPdfBuffer(buffer: ArrayBuffer | Buffer | null): boolean {
  if (!buffer) return false;
  const view = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer);
  if (view.byteLength < 500) return false;
  return view[0] === 0x25 && view[1] === 0x50 && view[2] === 0x44 && view[3] === 0x46 && view[4] === 0x2d;
}

async function tryDigioDownload(url: string, authHeader: string, label: string): Promise<Buffer | null> {
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
    console.info("[agreement/signed-pdf] downloaded PDF", { label, byteLength: ab.byteLength });
    return Buffer.from(ab);
  } catch (err) {
    console.warn("[agreement/signed-pdf] network error", { label, err: err instanceof Error ? err.message : String(err) });
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

    const cacheKey = `agreements/${leadId}/signed.pdf`;

    // 1) Bucket cache.
    let pdf = await getNbfcObject(cacheKey);
    if (pdf && !isValidPdfBuffer(pdf)) pdf = null;

    // 2-4) Provider fallbacks.
    if (!pdf) {
      const authHeader = getDigioBasicAuth();
      if (!authHeader) {
        return NextResponse.json({ ok: false, error: "eSign provider is not configured (contact iTarang support)" }, { status: 500 });
      }
      const baseUrl = getDigioBaseUrl();
      const encId = encodeURIComponent(row.digio_document_id);
      pdf = await tryDigioDownload(`${baseUrl}/v2/client/document/download?document_id=${encId}`, authHeader, "direct-query");
      if (!pdf) pdf = await tryDigioDownload(`${baseUrl}/v2/client/document/${encId}/download`, authHeader, "direct-path");
      if (!pdf) {
        try {
          const statusRes = await fetch(`${baseUrl}/v2/client/document/${encId}`, {
            method: "GET",
            headers: { Authorization: authHeader, Accept: "application/json" },
            cache: "no-store",
          });
          if (statusRes.ok) {
            const parsed = await statusRes.json().catch(() => null);
            const extracted = extractSignedAgreementUrl(parsed);
            if (extracted) pdf = await tryDigioDownload(extracted, authHeader, "extracted-url");
          }
        } catch (err) {
          console.warn("[agreement/signed-pdf] status fetch threw", { err: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    if (!pdf) {
      return NextResponse.json(
        { ok: false, error: "Could not retrieve the signed agreement yet — please try again shortly." },
        { status: 502 },
      );
    }

    // §17.4 — cache + stamp only when the NBFC opted into storage.
    if (row.store_loan_agreement) {
      try {
        const { url } = await putNbfcObject(cacheKey, pdf, "application/pdf");
        if (row.signed_document_url !== url) {
          await db.update(nbfcLoanAgreements).set({ signed_document_url: url, updated_at: new Date() }).where(eq(nbfcLoanAgreements.id, row.id));
        }
      } catch (err) {
        console.warn("[agreement/signed-pdf] cache/stamp failed", { err: err instanceof Error ? err.message : String(err) });
      }
    }

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="loan-agreement-${leadId}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.startsWith("UNAUTHORIZED") ? 401 : msg.startsWith("FORBIDDEN") ? 403 : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: code });
  }
}
