/**
 * GET /api/lead/[id]/nbfc-requests
 *
 * E-239 — the direct NBFC → dealer document requests on a lead, for the Step-4
 * pre-sanction card. Returns only `dealer_direct` wrappers that are still open;
 * admin-gated requests reach the dealer through the existing
 * `other_document_requests` surface on Step 2/3, and repeating them here would
 * double-ask for the same document.
 *
 * Role: dealer, must own the lead (mirrors /api/lead/[id]/pre-sanction-doc).
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { listDealerRequestsForLead } from "@/lib/nbfc/doc-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;

    const [lead] = await db
      .select({ id: leads.id, dealer_id: leads.dealer_id })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) {
      return NextResponse.json({ ok: false, error: "Lead not found" }, { status: 404 });
    }
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json({ ok: false, error: "Access denied" }, { status: 403 });
    }

    const requests = await listDealerRequestsForLead(leadId);
    return NextResponse.json({ ok: true, requests });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load requests";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
