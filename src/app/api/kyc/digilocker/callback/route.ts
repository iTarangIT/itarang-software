import { NextRequest, NextResponse } from "next/server";

import { publicOrigin } from "@/lib/public-origin";

/**
 * No-segment DigiLocker callback handler.
 *
 * The path-segment-aware callback at ../callback/[transactionId]/route.ts
 * looks up a `digilockerTransactions` row by id. The co-borrower DigiLocker
 * flow (executeCoBorrowerDigilockerInit in src/lib/kyc/coborrower-verification.ts)
 * doesn't write to that table — it stores session data in
 * kyc_verifications.api_response.data — so its redirect_url omits the
 * digiId path segment. Decentro then redirects the customer here after
 * consent.
 *
 * Functional sync (eAadhaar fetch) happens via admin-side polling at
 * /api/admin/kyc/[leadId]/coborrower/aadhaar/digilocker/status/[transactionId]
 * which calls executeCoBorrowerDigilockerStatus -> digilockerGetEaadhaar.
 * So this handler doesn't need to write anything — it just lands the
 * customer on the same friendly success / failed page primary uses
 * (lines 83-85 of [transactionId]/route.ts) instead of Next.js's 404.
 *
 * IMPORTANT — host resolution: behind a reverse proxy (nginx → 127.0.0.1:3003)
 * `req.nextUrl.origin` resolves to the *internal* host (localhost:3003), so
 * redirects built off it send the customer's browser to a host they can't
 * reach. Mirror primary's [transactionId] callback (line 69) and resolve
 * the public origin via publicOrigin({ req }), which validates and falls
 * back through NEXT_PUBLIC_APP_URL → VERCEL_URL → request-header host.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const status = (searchParams.get("status") || "").toUpperCase();
  const ok = status === "SUCCESS";
  const path = ok ? "/kyc/digilocker/success" : "/kyc/digilocker/failed";

  let base: string;
  try {
    base = publicOrigin({ req });
  } catch {
    // No safe public host derivable — last-resort fallback to the request's
    // own origin. Worse than publicOrigin (may be the proxy-internal host)
    // but better than throwing on a customer-facing redirect.
    base = req.nextUrl.origin;
  }
  return NextResponse.redirect(new URL(path, base));
}
