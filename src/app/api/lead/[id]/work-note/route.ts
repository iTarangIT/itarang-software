// ID 183 (21 Oct) — GET /api/lead/[id]/work-note
//
// What the dealer portal's lead / KYC / product / Step 5 screens show about
// iTarang working the file (LeadWorkNote):
//   - the 30-minute "being worked by <name>" note — before, only the CRM
//     "Act for dealer" panel showed it, so the dealer never knew;
//   - for the house login on a file it pushed out: the dealer's last action
//     as of this read, which its saves send back as x-seen-dealer-action-at,
//     so a save made after the dealer acted is refused (dealer wins) — the
//     same check the CRM panel has.
//
// The file's own dealer and the house login on a file it pushed out only
// (gateLeadActor, read); everyone else gets 403 and the strip stays hidden.

import { NextResponse } from "next/server";

import { isNextRedirectError } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { leadForGate, readWorkNote } from "@/lib/leads/actForDealerGuard";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole(["dealer"]);
    const lead = await leadForGate((await params).id);
    if (!lead) return NextResponse.json({ success: false, error: { message: "Lead not found" } }, { status: 404 });
    const r = await readWorkNote(user, lead);
    if (!r.ok) return NextResponse.json({ success: false, error: { message: r.message } }, { status: r.status });
    return NextResponse.json({ success: true, data: r.note });
  } catch (err) {
    if (isNextRedirectError(err)) return NextResponse.json({ success: false, error: { message: "Unauthorized" } }, { status: 401 });
    console.error("[work-note] read failed:", err);
    return NextResponse.json({ success: false, error: { message: "Could not read the file's work note" } }, { status: 500 });
  }
}
