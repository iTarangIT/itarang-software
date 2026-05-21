/**
 * GET /api/admin/nbfc/{nbfcId}/lsp-agreement/signed-pdf
 *
 * On-demand proxy that streams the signed LSP agreement PDF from Digio
 * (or a local cache) to the browser as `application/pdf` with
 * `Content-Disposition: attachment`. Mirrors the working dealer route at
 * src/app/api/admin/dealer-verifications/[dealerId]/download-signed-agreement/route.ts.
 *
 * Why a proxy instead of a pre-cached public URL: the multi_templates
 * download endpoints have at least 4 silent-failure modes (returns JSON
 * not PDF, returns redirect we can't follow, returns empty body) and the
 * "cache first, render button later" approach left the panel stuck on a
 * spinner. With the proxy, the button always renders when the agreement
 * is COMPLETED and any Digio failure becomes a real HTTP error the user
 * can see and we can log.
 *
 * Fallback chain (first hit wins):
 *   1. Local disk cache at public/nbfc-uploads/{nbfcId}/lsp-agreement/signed.pdf
 *   2. Digio /v2/client/document/download?document_id={id}
 *   3. Digio /v2/client/document/{id}/download
 *   4. Digio status JSON at /v2/client/document/{id} + extractSignedAgreementUrl
 *
 * Auth: same admin/CEO/test-bypass gate as the other NBFC admin routes.
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
import { extractSignedAgreementUrl } from "@/lib/digio/parse-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidPdfBuffer(buffer: ArrayBuffer | Buffer | null): boolean {
  if (!buffer) return false;
  const view = Buffer.isBuffer(buffer)
    ? buffer
    : Buffer.from(buffer as ArrayBuffer);
  if (view.byteLength < 500) return false;
  // %PDF- magic header
  return (
    view[0] === 0x25 &&
    view[1] === 0x50 &&
    view[2] === 0x44 &&
    view[3] === 0x46 &&
    view[4] === 0x2d
  );
}

async function readLocalCache(
  nbfcId: number,
  filename: string,
): Promise<Buffer | null> {
  const absPath = path.join(
    process.cwd(),
    "public",
    "nbfc-uploads",
    String(nbfcId),
    "lsp-agreement",
    filename,
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
  filename: string,
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
    await fs.writeFile(path.join(absDir, filename), buf);
    return "/" + path.posix.join("nbfc-uploads", String(nbfcId), "lsp-agreement", filename);
  } catch (err) {
    console.warn("[lsp-agreement/signed-pdf] cache write failed", {
      nbfcId,
      filename,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function tryDigioDownload(
  url: string,
  authHeader: string,
  label: string,
): Promise<Buffer | null> {
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
      console.warn("[lsp-agreement/signed-pdf] download non-ok", {
        label,
        url,
        status: res.status,
        body: body.slice(0, 400),
      });
      return null;
    }
    if (ct.includes("json")) {
      const body = await res.text().catch(() => "");
      console.warn("[lsp-agreement/signed-pdf] returned JSON, not PDF", {
        label,
        url,
        contentType: ct,
        body: body.slice(0, 400),
      });
      return null;
    }
    const ab = await res.arrayBuffer();
    if (!isValidPdfBuffer(ab)) {
      console.warn("[lsp-agreement/signed-pdf] invalid PDF buffer", {
        label,
        url,
        byteLength: ab.byteLength,
      });
      return null;
    }
    console.info("[lsp-agreement/signed-pdf] downloaded PDF", {
      label,
      url,
      byteLength: ab.byteLength,
    });
    return Buffer.from(ab);
  } catch (err) {
    console.warn("[lsp-agreement/signed-pdf] network error", {
      label,
      url,
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

  // 1) Local cache
  let pdf = await readLocalCache(nbfcId, "signed.pdf");

  // 2-4) Digio fallbacks
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
    const docId = agreement.digio_document_id;
    const encId = encodeURIComponent(docId);

    pdf = await tryDigioDownload(
      `${baseUrl}/v2/client/document/download?document_id=${encId}`,
      authHeader,
      "direct-query",
    );

    if (!pdf) {
      pdf = await tryDigioDownload(
        `${baseUrl}/v2/client/document/${encId}/download`,
        authHeader,
        "direct-path",
      );
    }

    if (!pdf) {
      // Status JSON → extract → fetch
      try {
        const statusUrl = `${baseUrl}/v2/client/document/${encId}`;
        const statusRes = await fetch(statusUrl, {
          method: "GET",
          headers: { Authorization: authHeader, Accept: "application/json" },
          cache: "no-store",
        });
        if (statusRes.ok) {
          const parsed = await statusRes.json().catch(() => null);
          const extracted = extractSignedAgreementUrl(parsed);
          console.info("[lsp-agreement/signed-pdf] status response", {
            documentId: docId,
            agreementStatus:
              parsed?.agreement_status ?? parsed?.status ?? null,
            extractedUrlFound: !!extracted,
          });
          if (extracted) {
            pdf = await tryDigioDownload(
              extracted,
              authHeader,
              "extracted-url",
            );
          }
        } else {
          const body = await statusRes.text().catch(() => "");
          console.warn("[lsp-agreement/signed-pdf] status endpoint non-ok", {
            url: statusUrl,
            status: statusRes.status,
            body: body.slice(0, 400),
          });
        }
      } catch (err) {
        console.warn("[lsp-agreement/signed-pdf] status fetch threw", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (!pdf) {
    return NextResponse.json(
      {
        success: false,
        message:
          "Could not fetch signed agreement from Digio. The document may not be ready yet — please try again in a few minutes, or check server logs for details.",
      },
      { status: 502 },
    );
  }

  // Best-effort: cache to disk + stamp the URL onto the agreement row so
  // future renders short-circuit and the next call hits the local cache.
  const publicUrl = await writeLocalCache(nbfcId, "signed.pdf", pdf);
  if (publicUrl && agreement.signed_pdf_url !== publicUrl) {
    try {
      await db
        .update(nbfcLspAgreements)
        .set({ signed_pdf_url: publicUrl, updated_at: new Date() })
        .where(eq(nbfcLspAgreements.id, agreement.id));
    } catch (err) {
      console.warn("[lsp-agreement/signed-pdf] DB stamp failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="lsp-agreement-${nbfcId}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
