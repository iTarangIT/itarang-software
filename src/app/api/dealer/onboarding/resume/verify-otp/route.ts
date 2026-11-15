import { NextRequest, NextResponse } from "next/server";

import { clientIp, takeIpToken } from "@/lib/auth/reset-throttle";
import { docBindingCookie } from "@/lib/onboarding/docBinding";
import { findResumableApplication, isMissingTable } from "@/lib/onboarding/resumeLookup";
import { checkResumeCode, WRONG_CODE } from "@/lib/onboarding/resumeCode";
import { onboardingDocumentLinks, onboardingStoredDocuments } from "@/lib/onboarding/onboardingFileLinks";
import { RESUME_OTP_FORMAT_RE, RESUME_TOKEN_TTL_MS } from "@/lib/onboarding/submitAccess";

/**
 * POST /api/dealer/onboarding/resume/verify-otp — tracker ID 129.
 *   { applicationId?, ownerEmail?, dealerCode?, code }
 *
 * Checks the code send-otp sent (by SMS to the owner mobile, or email). Right code → a resume token for that one
 * application, valid 30 minutes, which POST /api/dealer/onboarding/submit
 * accepts as proof of ownership. A code works once and dies after five wrong
 * entries.
 *
 * ID 166-C: the right code also binds THIS browser to the application (an
 * httpOnly cookie, lib/onboarding/docBinding.ts). The document links below open
 * only in this browser.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAVAILABLE =
  "Continuing an application by code is not available yet. Please contact your iTarang sales contact.";

export async function POST(req: NextRequest) {
  try {
    if (!takeIpToken(clientIp(req))) {
      return NextResponse.json(
        { success: false, message: "Too many attempts. Please wait a few minutes and try again." },
        { status: 429 },
      );
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    // Malformed input is refused without burning an attempt (and without a lookup).
    if (!RESUME_OTP_FORMAT_RE.test((str(body?.code) ?? "").trim())) {
      return NextResponse.json(
        { success: false, message: "Enter the 6-digit code we sent you." },
        { status: 400 },
      );
    }

    const application = await findResumableApplication({
      applicationId: str(body?.applicationId),
      ownerEmail: str(body?.ownerEmail),
      dealerCode: str(body?.dealerCode),
    });
    if (!application) return NextResponse.json({ success: false, message: WRONG_CODE }, { status: 400 });

    const checked = await checkResumeCode(application.id, body?.code);
    if (!checked.ok) {
      return NextResponse.json({ success: false, message: checked.message }, { status: checked.status });
    }
    const { resumeToken } = checked;

    // ID 166 decision 5 (confirmed 23 Oct): the code proved this is the
    // dealer's own application, so it gets fresh links to its own earlier
    // uploads — that application only, each valid 15 minutes (signed for the
    // application, not a login). Keyed by the stored URL the form holds; a
    // newer view mints again via POST /api/dealer/onboarding/file-link.
    const documentLinks = await onboardingDocumentLinks(application.id).catch((err) => {
      console.error("[onboarding/resume/verify-otp] document links failed:", err);
      return {} as Record<string, string>;
    });
    // ID 166-B: the same documents by type + storage path, so the form can show
    // them in their slots even when this browser kept nothing (another phone).
    const documents = await onboardingStoredDocuments(application.id).catch((err) => {
      console.error("[onboarding/resume/verify-otp] stored documents failed:", err);
      return [];
    });

    const res = NextResponse.json({
      success: true,
      applicationId: application.id,
      resumeToken,
      documentLinks,
      documents,
      expiresInSeconds: Math.round(RESUME_TOKEN_TTL_MS / 1000),
    });
    res.cookies.set(docBindingCookie(resumeToken));
    return res;
  } catch (err) {
    if (isMissingTable(err)) {
      return NextResponse.json({ success: false, message: UNAVAILABLE }, { status: 503 });
    }
    console.error("[onboarding/resume/verify-otp]", err);
    return NextResponse.json(
      { success: false, message: "Could not check the code. Please try again." },
      { status: 500 },
    );
  }
}
