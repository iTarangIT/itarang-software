import { NextRequest, NextResponse } from "next/server";

import { renderDocumentPage, verifyViewAccessForRequest } from "@/lib/onboarding/existingViewData";

/**
 * GET /api/dealer/onboarding/existing/{viewToken}/doc/{documentId}?p=0
 *
 * One page of a document on the view-only "existing application" page, as an
 * image. Only for the browser that entered the mobile code, while the view
 * link is live and still the latest (lib/onboarding/existingView.ts). A PDF is
 * rasterised here, so the original file never reaches the browser. Not cached.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string; docId: string }> }) {
  const { token, docId } = await ctx.params;
  const access = verifyViewAccessForRequest(req, decodeURIComponent(token));
  if (!access.ok) {
    return NextResponse.json({ error: "expired", reason: access.reason }, { status: 403, headers: NO_STORE });
  }
  if (!/^[0-9a-f-]{36}$/i.test(docId)) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  const p = Number(req.nextUrl.searchParams.get("p") ?? "0");
  const pageIndex = Number.isInteger(p) && p >= 0 ? p : 0;

  try {
    const page = await renderDocumentPage(access.view.applicationId, docId, pageIndex);
    if (!page) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    return new NextResponse(new Uint8Array(page.body), {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": page.contentType,
        "Content-Disposition": "inline",
        "X-Page-Count": String(page.pageCount),
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex",
      },
    });
  } catch (err) {
    console.error("[onboarding/existing/doc]", err);
    return NextResponse.json({ error: "Could not open this document." }, { status: 500, headers: NO_STORE });
  }
}
