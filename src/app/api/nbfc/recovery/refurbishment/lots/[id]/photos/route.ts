/**
 * E-270 — POST /api/nbfc/recovery/refurbishment/lots/[id]/photos (NBFC side)
 *
 * Multipart `file[]` + `target` (out_dispatch | ret_receipt | item:<job>:return).
 * See src/lib/nbfc/recovery/refurb-photo-upload.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { handleLotPhotoUpload, photoStatusFromError } from "@/lib/nbfc/recovery/refurb-photo-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;
    return await handleLotPhotoUpload(req, id, actor.tenant_id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: photoStatusFromError(msg) });
  }
}
