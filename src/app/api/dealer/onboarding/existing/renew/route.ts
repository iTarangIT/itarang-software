import { NextRequest, NextResponse } from "next/server";

import {
  canRenewView,
  EXISTING_VIEW_COOKIE,
  readViewToken,
  signViewToken,
  viewCookie,
  viewPath,
} from "@/lib/onboarding/existingView";

/**
 * POST /api/dealer/onboarding/existing/renew   { token }
 *
 * The 15 minutes of a view-only link ran out: a NEW link, for the same
 * application, in the same browser — only the browser holding that link's
 * nonce cookie (2 hours). The new nonce replaces the cookie, so the old URL
 * stops working. Anywhere else, the person presses Submit on the form again.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token : null;
  if (!readViewToken(token)) {
    return NextResponse.json({ success: false, message: "This link is not valid." }, { status: 400 });
  }

  const view = canRenewView(token, req.cookies.get(EXISTING_VIEW_COOKIE)?.value);
  if (!view) {
    return NextResponse.json(
      { success: false, formRequired: true, message: "Go back to the onboarding form and press Submit again to open a new link." },
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
