import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { coBorrowers, consentRecords } from "@/lib/db/schema";

// Public GET/POST endpoint for the co-borrower consent landing page. The
// endpoint is token-gated — no auth — the random 32-byte token from
// /api/coborrower/[leadId]/send-consent is the access control.

async function findValidConsent(leadId: string, token: string) {
  const rows = await db
    .select()
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.lead_id, leadId),
        eq(consentRecords.consent_for, "co_borrower"),
        eq(consentRecords.consent_token, token),
      ),
    )
    .orderBy(desc(consentRecords.created_at))
    .limit(1);
  return rows[0] ?? null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ leadId: string; token: string }> },
) {
  try {
    const { leadId, token } = await params;
    const consent = await findValidConsent(leadId, token);
    if (!consent) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "This consent link is invalid or has expired." },
        },
        { status: 404 },
      );
    }

    const cobRows = await db
      .select()
      .from(coBorrowers)
      .where(eq(coBorrowers.lead_id, leadId))
      .limit(1);
    const cob = cobRows[0];

    return NextResponse.json({
      success: true,
      data: {
        coBorrowerName: cob?.full_name ?? null,
        leadReference: leadId,
        alreadySigned:
          consent.consent_status === "digitally_signed" ||
          consent.consent_status === "verified",
      },
    });
  } catch (error) {
    console.error("[Co-Borrower Consent GET] Error:", error);
    return NextResponse.json(
      { success: false, error: { message: "Server error" } },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string; token: string }> },
) {
  try {
    const { leadId, token } = await params;
    const consent = await findValidConsent(leadId, token);
    if (!consent) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "This consent link is invalid or has expired." },
        },
        { status: 404 },
      );
    }

    if (
      consent.consent_status === "digitally_signed" ||
      consent.consent_status === "verified"
    ) {
      return NextResponse.json({
        success: true,
        data: { alreadySigned: true },
      });
    }

    const body = await req.json().catch(() => ({}));
    const fullName =
      typeof body.full_name === "string" ? body.full_name.trim() : "";
    if (!fullName) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "Full name is required to sign digitally." },
        },
        { status: 400 },
      );
    }

    const now = new Date();
    await db
      .update(consentRecords)
      .set({
        consent_status: "digitally_signed",
        consent_type: consent.consent_type ?? "digital",
        signed_at: now,
        updated_at: now,
      })
      .where(eq(consentRecords.id, consent.id));

    await db
      .update(coBorrowers)
      .set({ consent_status: "digitally_signed", updated_at: now })
      .where(eq(coBorrowers.lead_id, leadId));

    return NextResponse.json({
      success: true,
      data: { signedAt: now.toISOString() },
    });
  } catch (error) {
    console.error("[Co-Borrower Consent POST] Error:", error);
    return NextResponse.json(
      { success: false, error: { message: "Server error" } },
      { status: 500 },
    );
  }
}
