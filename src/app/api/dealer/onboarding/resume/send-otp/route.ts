import { NextRequest, NextResponse } from "next/server";

import { clientIp, takeIpToken } from "@/lib/auth/reset-throttle";
import { findResumableApplication, isMissingTable } from "@/lib/onboarding/resumeLookup";
import { sendResumeCode } from "@/lib/onboarding/resumeCode";
import { verifyResumeToken } from "@/lib/onboarding/submitAccess";

/**
 * POST /api/dealer/onboarding/resume/send-otp — tracker ID 129.
 *   { applicationId?, ownerEmail?, dealerCode? }
 *
 * A dealer with no login wants to continue an application that already exists.
 * This sends a one-time code to the owner MOBILE on the application by SMS
 * (ID 166 decision 5, 16 Oct; 2Factor → MSG91 → a 2Factor voice call), and to
 * the owner e-mail on the application when there is no usable mobile or every
 * SMS provider fails — never to a number or address the request supplies; the
 * typed e-mail is only used to find the application. Entering the code
 * (verify-otp) yields the resume token the submit route accepts. OTP_DRY_RUN=1
 * writes the code to the server log and sends nothing.
 *
 * Public by necessity (the dealer has no account). Throttled per IP and per
 * application, and it reveals nothing the submit route's 409 did not already:
 * that an application exists, and a masked address.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAVAILABLE =
  "Continuing an application by code is not available yet. Please contact your iTarang sales contact.";

export async function POST(req: NextRequest) {
  try {
    if (!takeIpToken(clientIp(req))) {
      return NextResponse.json(
        { success: false, message: "Too many requests. Please wait a few minutes and try again." },
        { status: 429 },
      );
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    // A caller already holding a valid token does not need another code.
    if (verifyResumeToken(str(body?.resumeToken))) {
      return NextResponse.json({ success: true, alreadyVerified: true });
    }

    const application = await findResumableApplication({
      applicationId: str(body?.applicationId),
      ownerEmail: str(body?.ownerEmail),
      dealerCode: str(body?.dealerCode),
    });
    if (!application) {
      return NextResponse.json(
        {
          success: false,
          message:
            "We could not find an application to continue, or it has no mobile number or email on file. Please contact your iTarang sales contact.",
        },
        { status: 404 },
      );
    }

    const sent = await sendResumeCode(application);
    if (!sent.ok) return NextResponse.json({ success: false, message: sent.message }, { status: sent.status });
    return NextResponse.json({ success: true, ...sent.body });
  } catch (err) {
    if (isMissingTable(err)) {
      return NextResponse.json({ success: false, message: UNAVAILABLE }, { status: 503 });
    }
    console.error("[onboarding/resume/send-otp]", err);
    return NextResponse.json(
      { success: false, message: "Could not send the code. Please try again." },
      { status: 500 },
    );
  }
}
