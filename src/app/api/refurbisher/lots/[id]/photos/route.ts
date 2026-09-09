/**
 * E-292 — POST /api/refurbisher/lots/[id]/photos (refurbisher side)
 *
 * Multipart `file[]` + `target` (ret_dispatch | ret_eway_bill). Scoped to the
 * partner's own lots. See src/lib/nbfc/recovery/refurb-photo-upload.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { requireRefurbisher, refurbisherStatusFromError } from "@/lib/refurbisher/auth";
import { handleLotPhotoUpload } from "@/lib/nbfc/recovery/refurb-photo-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireRefurbisher();
    const { id } = await ctx.params;
    return await handleLotPhotoUpload(req, id, { refurbisher_id: actor.refurbisher_id }, "refurbisher");
  } catch (e) {
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: refurbisherStatusFromError(e) });
  }
}
