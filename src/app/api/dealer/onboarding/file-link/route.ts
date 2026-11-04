import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { dealerCorrectionRounds } from "@/lib/db/schema";
import { hashCorrectionToken } from "@/lib/onboarding/correction-token";
import { onboardingFileLinkFor } from "@/lib/onboarding/onboardingFileLinks";
import { verifyResumeToken } from "@/lib/onboarding/submitAccess";

/**
 * POST /api/dealer/onboarding/file-link — tracker ID 166 (decision 5).
 *   { url, resumeToken? | correctionToken? }
 *
 * A dealer with no login views its own earlier onboarding uploads: each view
 * mints a fresh link, valid 15 minutes, signed for the application (not a
 * login). The proof the application is the caller's own is either the resume
 * token (after the mobile code) or a live correction link. The file must be
 * one of THAT application's documents, matched on bucket/key.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOPE = "This file can't be opened from here. Please contact your iTarang sales contact.";

async function applicationFromCorrectionToken(raw: string): Promise<string | null> {
  const [round] = await db
    .select({
      applicationId: dealerCorrectionRounds.application_id,
      status: dealerCorrectionRounds.status,
      expiresAt: dealerCorrectionRounds.token_expires_at,
    })
    .from(dealerCorrectionRounds)
    .where(eq(dealerCorrectionRounds.token_hash, hashCorrectionToken(raw)))
    .limit(1);
  if (!round) return null;
  if (round.expiresAt && new Date(round.expiresAt).getTime() < Date.now()) return null;
  // Same states the correction page itself still serves.
  if (["superseded", "cancelled", "submitted", "applied"].includes(String(round.status))) return null;
  return round.applicationId;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const url = str(body?.url);
    const resumeToken = str(body?.resumeToken);
    const correctionToken = str(body?.correctionToken);
    if (!url || (!resumeToken && !correctionToken)) {
      return NextResponse.json({ success: false, message: NOPE }, { status: 400 });
    }

    const applicationId = resumeToken
      ? verifyResumeToken(resumeToken)
      : await applicationFromCorrectionToken(correctionToken!);
    if (!applicationId) return NextResponse.json({ success: false, message: NOPE }, { status: 403 });

    const link = await onboardingFileLinkFor(applicationId, url);
    if (!link) return NextResponse.json({ success: false, message: NOPE }, { status: 404 });

    return NextResponse.json({ success: true, url: link }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[onboarding/file-link]", err);
    return NextResponse.json({ success: false, message: "Could not open the file. Please try again." }, { status: 500 });
  }
}
