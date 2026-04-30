import { NextRequest, NextResponse } from "next/server";

import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { executeCoBorrowerDigilockerInit } from "@/lib/kyc/coborrower-verification";
import { publicOrigin, PublicOriginError } from "@/lib/public-origin";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId } = await params;
    const body = await req.json().catch(() => ({}));

    // Resolve redirect_url through the same safe-host helper primary uses
    // (src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/initiate/route.ts:128-147).
    // Previously the helper read process.env.NEXT_PUBLIC_APP_URL directly, which
    // on a sandbox where that env is set to http://localhost:3003 caused
    // Decentro to redirect customers to localhost — unreachable from their
    // browsers. publicOrigin rejects localhost / ngrok / .local in production
    // and falls back to validated request headers, matching primary behaviour.
    let callbackUrl: string;
    try {
      const callbackBase = publicOrigin({ req });
      callbackUrl = body.redirect_url || `${callbackBase}/api/kyc/digilocker/callback`;
    } catch (err) {
      if (err instanceof PublicOriginError) {
        return NextResponse.json(
          {
            success: false,
            error: {
              message:
                "Cannot initiate DigiLocker: no safe callback URL available. " +
                "Ask ops to set NEXT_PUBLIC_APP_URL to the deployed origin.",
              code: err.code,
            },
          },
          { status: 500 },
        );
      }
      throw err;
    }

    const result = await executeCoBorrowerDigilockerInit(leadId, {
      phone: body.phone,
      email: body.email,
      redirect_url: callbackUrl,
    });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: { message: result.error } },
        { status: result.status },
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Co-Borrower DigiLocker Init] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to initiate co-borrower DigiLocker session";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
