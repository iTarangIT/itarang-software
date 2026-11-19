/**
 * GET /api/nbfc/acquire/[leadId]/cibil-review/file
 *
 * E-387 — streams the latest CIBIL report PDF for this lead to a logged-in
 * member of the owning NBFC tenant. No public or signed link is handed out.
 */
import { NextRequest, NextResponse } from "next/server";

import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getLatestCibilReview } from "@/lib/nbfc/approval-hierarchy";
import { getNbfcObject } from "@/lib/nbfc/nbfc-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    const review = await getLatestCibilReview(actor.tenant_id, leadId);
    if (!review) return NextResponse.json({ ok: false, error: "NOT_FOUND: no CIBIL report on this lead" }, { status: 404 });
    const pdf = await getNbfcObject(review.report_url);
    if (!pdf) return NextResponse.json({ ok: false, error: "NOT_FOUND: the CIBIL report file is missing" }, { status: 404 });
    const name = (review.report_file_name || `cibil-${leadId}.pdf`).replace(/"/g, "");
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${name}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED") ? 401 : msg.startsWith("FORBIDDEN") ? 403 : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status });
  }
}
