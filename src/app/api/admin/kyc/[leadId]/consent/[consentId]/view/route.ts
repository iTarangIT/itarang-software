import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { consentRecords } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";

export async function POST(
  _req: NextRequest,
  {
    params,
  }: { params: Promise<{ leadId: string; consentId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId, consentId } = await params;

    const existing = await db
      .select()
      .from(consentRecords)
      .where(
        and(
          eq(consentRecords.id, consentId),
          eq(consentRecords.lead_id, leadId),
        ),
      )
      .limit(1);

    if (!existing.length) {
      return NextResponse.json(
        { success: false, error: { message: "Consent record not found" } },
        { status: 404 },
      );
    }

    const record = existing[0];

    if (record.admin_viewed_at) {
      return NextResponse.json({
        success: true,
        consent: {
          id: record.id,
          adminViewedBy: record.admin_viewed_by,
          adminViewedAt: record.admin_viewed_at,
        },
      });
    }

    const now = new Date();
    const [updated] = await db
      .update(consentRecords)
      .set({
        admin_viewed_by: appUser.id,
        admin_viewed_at: now,
        updated_at: now,
      })
      .where(eq(consentRecords.id, consentId))
      .returning({
        id: consentRecords.id,
        admin_viewed_by: consentRecords.admin_viewed_by,
        admin_viewed_at: consentRecords.admin_viewed_at,
      });

    return NextResponse.json({
      success: true,
      consent: {
        id: updated.id,
        adminViewedBy: updated.admin_viewed_by,
        adminViewedAt: updated.admin_viewed_at,
      },
    });
  } catch (error) {
    console.error("[Admin Consent View] Error:", error);
    const message = error instanceof Error ? error.message : "Server error";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
