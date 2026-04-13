import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { consentRecords } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";

const ALLOWED_ACTIONS = new Set(["approve", "reject"]);

export async function POST(
  req: NextRequest,
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
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    const action = body.action;

    if (!action || !ALLOWED_ACTIONS.has(action)) {
      return NextResponse.json(
        { success: false, error: { message: "Invalid action" } },
        { status: 400 },
      );
    }

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
    if (
      record.consent_status === "verified" ||
      record.consent_status === "rejected"
    ) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `Consent already ${record.consent_status}`,
          },
        },
        { status: 409 },
      );
    }

    const now = new Date();
    const nextStatus = action === "approve" ? "verified" : "rejected";

    const [updated] = await db
      .update(consentRecords)
      .set({
        consent_status: nextStatus,
        verified_by: appUser.id,
        verified_at: now,
        updated_at: now,
      })
      .where(eq(consentRecords.id, consentId))
      .returning({
        id: consentRecords.id,
        consent_status: consentRecords.consent_status,
        verified_by: consentRecords.verified_by,
        verified_at: consentRecords.verified_at,
      });

    return NextResponse.json({
      success: true,
      consent: {
        id: updated.id,
        consentStatus: updated.consent_status,
        verifiedBy: updated.verified_by,
        verifiedAt: updated.verified_at,
      },
    });
  } catch (error) {
    console.error("[Admin Consent Verify] Error:", error);
    const message = error instanceof Error ? error.message : "Server error";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
