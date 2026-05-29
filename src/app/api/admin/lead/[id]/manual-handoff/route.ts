/**
 * GET /api/admin/lead/[id]/manual-handoff — current Manual Handoff state for a
 * lead (§11.7), or null if none sent. Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { manualHandoffs } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdminAppUser();
    if (!admin) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 403 });
    }
    const { id: leadId } = await params;
    const [handoff] = await db.select().from(manualHandoffs).where(eq(manualHandoffs.lead_id, leadId)).limit(1);
    return NextResponse.json({ ok: true, handoff: handoff ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
