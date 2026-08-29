/**
 * E-270 — POST /api/admin/nbfc/refurbishment/lots/[id]/photos (iTarang side)
 *
 * Multipart `file[]` + `target` (out_receipt | ret_dispatch | item:<job>:out).
 * See src/lib/nbfc/recovery/refurb-photo-upload.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";
import { handleLotPhotoUpload } from "@/lib/nbfc/recovery/refurb-photo-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REFURB_ACT_ROLES = new Set(["admin", "ceo", "business_head", "sales_head"]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!REFURB_ACT_ROLES.has(actor.role)) throw new Error("FORBIDDEN: cannot act on refurbishment lots");
    const { id } = await ctx.params;
    return await handleLotPhotoUpload(req, id, null);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}
