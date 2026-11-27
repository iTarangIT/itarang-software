import { NextRequest, NextResponse } from "next/server";

import { boundApplication } from "@/lib/onboarding/docBinding";
import { readViewToken, signViewToken, viewCookie, viewPath } from "@/lib/onboarding/existingView";

/**
 * POST /api/dealer/onboarding/existing/renew   { token }
 *
 * The 15 minutes of a view-only link ran out: a NEW link, for the same
 * application, in the same browser — only while this browser's code check is
 * still good (the 30-minute resume cookie, docBinding.ts). The new nonce
 * replaces the cookie, so the old URL stops working. Past that, the dealer
 * enters a fresh mobile code (resume/send-otp + verify-otp).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const view = readViewToken(typeof body?.token === "string" ? body.token : null);
  if (!view) return NextResponse.json({ success: false, message: "This link is not valid." }, { status: 400 });

  if (boundApplication(req.cookies) !== view.applicationId) {
    return NextResponse.json(
      { success: false, codeRequired: true, message: "Enter the code we send to the registered mobile to open a new link." },
      { status: 401 },
    );
  }

  const next = signViewToken(view.applicationId);
  if (!next) return NextResponse.json({ success: false, message: "Viewing is not available right now." }, { status: 503 });
  const res = NextResponse.json({ success: true, viewUrl: viewPath(next.token), expiresAt: next.exp });
  res.cookies.set(viewCookie(next));
  res.headers.set("Cache-Control", "no-store");
  return res;
}
