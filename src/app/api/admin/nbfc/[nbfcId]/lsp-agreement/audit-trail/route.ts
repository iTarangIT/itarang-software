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
import path from "node:path";
import fs from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfc, nbfcLspAgreements } from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";
import {
  getDigioBaseUrl,
  getDigioBasicAuth,
} from "@/lib/digio/client";

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

async function readLocalCache(nbfcId: number): Promise<Buffer | null> {
  const absPath = path.join(
    process.cwd(),
    "public",
    "nbfc-uploads",
    String(nbfcId),
    "lsp-agreement",
    "audit-trail.pdf",
  );
  try {
    const buf = await fs.readFile(absPath);
    if (!isValidPdfBuffer(buf)) return null;
    return buf;
  } catch {
    return null;
  }
}

async function writeLocalCache(
  nbfcId: number,
  buf: Buffer,
): Promise<string | null> {
  const absDir = path.join(
    process.cwd(),
    "public",
    "nbfc-uploads",
    String(nbfcId),
    "lsp-agreement",
  );
  try {
    await fs.mkdir(absDir, { recursive: true });
    await fs.writeFile(path.join(absDir, "audit-trail.pdf"), buf);
    return "/" + path.posix.join("nbfc-uploads", String(nbfcId), "lsp-agreement", "audit-trail.pdf");
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
    .select({ id: nbfc.id, lsp_agreement_id: nbfc.lsp_agreement_id })
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
    return NextResponse.json(
      {
        success: false,
        message:
          "Could not fetch audit trail from Digio. The audit trail may not be available yet — please try again in a few minutes.",
      },
      { status: 502 },
    );
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
