import { NextRequest, NextResponse } from "next/server";

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
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const status = (searchParams.get("status") || "").toUpperCase();
  const ok = status === "SUCCESS";
  const target = ok ? "/kyc/digilocker/success" : "/kyc/digilocker/failed";
  return NextResponse.redirect(new URL(target, req.nextUrl.origin));
}
