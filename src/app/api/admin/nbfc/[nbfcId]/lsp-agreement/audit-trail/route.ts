/**
 * GET /api/admin/nbfc/{nbfcId}/lsp-agreement/audit-trail
 *
 * On-demand proxy for the Digio audit-trail PDF. Same architecture as the
 * sibling /signed-pdf route — local cache first, single Digio endpoint
 * fallback (`download_audit_trail?document_id=...`), validate magic
 * bytes, stream with `Content-Disposition: attachment`.
 *
 * Auth: same admin/CEO/test-bypass gate.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfc, nbfcLspAgreements } from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";
import { getNbfcObject, putNbfcObject } from "@/lib/nbfc/nbfc-storage";
import {
  getDigioBaseUrl,
  getDigioBasicAuth,
} from "@/lib/digio/client";
import { generateAuditRecordPdf } from "@/lib/nbfc/agreement-audit-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUDIT_TRAIL_PATH =
  process.env.DIGIO_AUDIT_TRAIL_PATH_TEMPLATE ||
  "/v2/client/document/download_audit_trail?document_id={documentId}";

function isValidPdfBuffer(buffer: ArrayBuffer | Buffer | null): boolean {
  if (!buffer) return false;
  const view = Buffer.isBuffer(buffer)
    ? buffer
    : Buffer.from(buffer as ArrayBuffer);
  if (view.byteLength < 500) return false;
  return (
    view[0] === 0x25 &&
    view[1] === 0x50 &&
    view[2] === 0x44 &&
    view[3] === 0x46 &&
    view[4] === 0x2d
  );
}

// Cache lives in the private `nbfc-documents` Supabase bucket (names kept for
// call-site stability; no longer local disk).
async function readLocalCache(nbfcId: number): Promise<Buffer | null> {
  const buf = await getNbfcObject(`${nbfcId}/lsp-agreement/audit-trail.pdf`);
  if (!buf || !isValidPdfBuffer(buf)) return null;
  return buf;
}

async function writeLocalCache(
  nbfcId: number,
  buf: Buffer,
): Promise<string | null> {
  try {
    const { url } = await putNbfcObject(`${nbfcId}/lsp-agreement/audit-trail.pdf`, buf, "application/pdf");
    return url;
  } catch (err) {
    console.warn("[lsp-agreement/audit-trail] cache write failed", {
      nbfcId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ nbfcId: string }> },
) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  const { nbfcId: nbfcIdRaw } = await ctx.params;
  const nbfcId = Number.parseInt(nbfcIdRaw, 10);
  if (!Number.isInteger(nbfcId) || nbfcId <= 0) {
    return NextResponse.json(
      { success: false, message: "Invalid nbfcId" },
      { status: 400 },
    );
  }

  const [nbfcRow] = await db
    .select({ id: nbfc.id, lsp_agreement_id: nbfc.lsp_agreement_id, legal_name: nbfc.legal_name, short_name: nbfc.short_name })
    .from(nbfc)
    .where(eq(nbfc.id, nbfcId))
    .limit(1);
  if (!nbfcRow) {
    return NextResponse.json(
      { success: false, message: "NBFC not found" },
      { status: 404 },
    );
  }
  if (!nbfcRow.lsp_agreement_id) {
    return NextResponse.json(
      { success: false, message: "No LSP agreement linked to this NBFC" },
      { status: 404 },
    );
  }

  const [agreement] = await db
    .select()
    .from(nbfcLspAgreements)
    .where(eq(nbfcLspAgreements.id, nbfcRow.lsp_agreement_id))
    .limit(1);
  if (!agreement) {
    return NextResponse.json(
      { success: false, message: "Agreement row not found" },
      { status: 404 },
    );
  }
  if (agreement.agreement_status !== "COMPLETED") {
    return NextResponse.json(
      {
        success: false,
        message: `Agreement is not yet completed (current status: ${agreement.agreement_status ?? "UNKNOWN"})`,
      },
      { status: 400 },
    );
  }
  if (!agreement.digio_document_id) {
    return NextResponse.json(
      { success: false, message: "Agreement has no Digio document id" },
      { status: 400 },
    );
  }

  let pdf = await readLocalCache(nbfcId);

  if (!pdf) {
    const authHeader = getDigioBasicAuth();
    if (!authHeader) {
      return NextResponse.json(
        {
          success: false,
          message: "DIGIO_CLIENT_ID / DIGIO_CLIENT_SECRET not configured",
        },
        { status: 500 },
      );
    }
    const baseUrl = getDigioBaseUrl();
    const url =
      baseUrl +
      AUDIT_TRAIL_PATH.replace(
        "{documentId}",
        encodeURIComponent(agreement.digio_document_id),
      );

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/pdf, application/octet-stream, */*",
        },
        cache: "no-store",
      });
      const ct = res.headers.get("content-type") || "";
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn("[lsp-agreement/audit-trail] download non-ok", {
          url,
          status: res.status,
          body: body.slice(0, 400),
        });
      } else if (ct.includes("json")) {
        const body = await res.text().catch(() => "");
        console.warn("[lsp-agreement/audit-trail] returned JSON, not PDF", {
          url,
          contentType: ct,
          body: body.slice(0, 400),
        });
      } else {
        const ab = await res.arrayBuffer();
        if (isValidPdfBuffer(ab)) {
          pdf = Buffer.from(ab);
          console.info("[lsp-agreement/audit-trail] downloaded PDF", {
            url,
            byteLength: ab.byteLength,
          });
        } else {
          console.warn("[lsp-agreement/audit-trail] invalid PDF buffer", {
            url,
            byteLength: ab.byteLength,
          });
        }
      }
    } catch (err) {
      console.warn("[lsp-agreement/audit-trail] network error", {
        url,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!pdf) {
    // No provider audit certificate available (recorded manually / different
    // eSign environment → ENTITY_NOT_FOUND). Generate iTarang's own audit record
    // so the admin always gets a document instead of an error.
    console.warn("[lsp-agreement/audit-trail] provider trail unavailable; serving iTarang audit record", { nbfcId });
    const fmtDate = (d: Date | string | null | undefined): string => {
      if (!d) return "—";
      const dt = d instanceof Date ? d : new Date(d);
      if (Number.isNaN(dt.getTime())) return "—";
      try {
        return new Intl.DateTimeFormat("en-IN", {
          day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
        }).format(dt) + " IST";
      } catch {
        return dt.toISOString();
      }
    };
    const fallback = await generateAuditRecordPdf({
      title: "iTarang — LSP Agreement Audit Record",
      intro: [
        "iTarang's internal signing/audit record for the iTarang & NBFC LSP agreement,",
        "generated from iTarang's immutable records. This is NOT the eSign provider's legal",
        "certificate - when that certificate is available, it is provided instead of this record.",
      ],
      rows: [
        { label: "NBFC", value: nbfcRow.legal_name || nbfcRow.short_name || String(nbfcId) },
        { label: "Agreement reference", value: agreement.agreement_id || String(agreement.id) },
        { label: "Signing method", value: "iTarang eSign" },
        { label: "Status", value: agreement.agreement_status ?? "—" },
        { label: "Last updated", value: fmtDate(agreement.updated_at) },
      ],
      footerNote: "iTarang facilitates and files the LSP agreement; document storage is optional.",
      generatedAt: new Date(),
    });
    return new NextResponse(new Uint8Array(fallback), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="lsp-audit-record-${nbfcId}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const publicUrl = await writeLocalCache(nbfcId, pdf);
  if (publicUrl && agreement.audit_trail_url !== publicUrl) {
    try {
      await db
        .update(nbfcLspAgreements)
        .set({ audit_trail_url: publicUrl, updated_at: new Date() })
        .where(eq(nbfcLspAgreements.id, agreement.id));
    } catch (err) {
      console.warn("[lsp-agreement/audit-trail] DB stamp failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="lsp-audit-trail-${nbfcId}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
