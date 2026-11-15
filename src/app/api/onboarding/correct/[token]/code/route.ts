import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { dealerCorrectionRounds } from "@/lib/db/schema";
import { clientIp, takeIpToken } from "@/lib/auth/reset-throttle";
import { hashCorrectionToken } from "@/lib/onboarding/correction-token";
import { docBindingCookie } from "@/lib/onboarding/docBinding";
import { findResumableApplication, isMissingTable } from "@/lib/onboarding/resumeLookup";
import { checkResumeCode, sendResumeCode } from "@/lib/onboarding/resumeCode";

/**
 * POST /api/onboarding/correct/{token}/code — tracker ID 166-C (decision 17).
 *   { action: "send" }            → a code to the owner mobile on the application
 *   { action: "verify", code }    → right code binds this browser to the application
 *
 * The correction link proves the dealer was sent it, but a forwarded link must
 * not show the dealer's PAN card or bank cheque to whoever has it. So before
 * the correction page shows any earlier document, the dealer enters the code
 * sent to the mobile ON THE APPLICATION (the same code and limits as resuming
 * an application, ID 129). A right code sets the httpOnly cookie
 * (lib/onboarding/docBinding.ts) the file links are checked against.
 *
 * Public (the dealer has no login): the correction token is the credential to
 * ask for a code, the code to see documents. Throttled per IP and per application.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ token: string }> };

const fail = (message: string, status: number) => NextResponse.json({ success: false, message }, { status });

async function liveRoundApplication(rawToken: string): Promise<string | null> {
  if (!rawToken) return null;
  const [round] = await db
    .select({
      applicationId: dealerCorrectionRounds.application_id,
      status: dealerCorrectionRounds.status,
      expiresAt: dealerCorrectionRounds.token_expires_at,
    })
    .from(dealerCorrectionRounds)
    .where(eq(dealerCorrectionRounds.token_hash, hashCorrectionToken(rawToken)))
    .limit(1);
  if (!round) return null;
  if (round.expiresAt && new Date(round.expiresAt).getTime() < Date.now()) return null;
  if (round.status !== "pending") return null;
  return round.applicationId;
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    if (!takeIpToken(clientIp(req))) {
      return fail("Too many attempts. Please wait a few minutes and try again.", 429);
    }
    const { token } = await context.params;
    const applicationId = await liveRoundApplication(token);
    if (!applicationId) return fail("This correction link is no longer valid. Please contact iTarang.", 404);

    const application = await findResumableApplication({ applicationId });
    if (!application) return fail("This correction link is no longer valid. Please contact iTarang.", 404);

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body?.action === "send") {
      const sent = await sendResumeCode(application);
      if (!sent.ok) return fail(sent.message, sent.status);
      return NextResponse.json({ success: true, ...sent.body });
    }
    if (body?.action === "verify") {
      const checked = await checkResumeCode(application.id, body.code);
      if (!checked.ok) return fail(checked.message, checked.status);
      const res = NextResponse.json({ success: true });
      res.cookies.set(docBindingCookie(checked.resumeToken));
      return res;
    }
    return fail("Unknown action.", 400);
  } catch (err) {
    if (isMissingTable(err)) {
      return fail("Codes are not available yet. Please contact your iTarang sales contact.", 503);
    }
    console.error("[onboarding/correct/code]", err);
    return fail("Something went wrong. Please try again.", 500);
  }
}
