import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireDealerValidationReader } from "@/lib/auth/requireSalesHead";
import { classifyGstinConflict } from "@/lib/dealer/duplicate-check";
import { maskDealerIdsDeep, maskIdsInText, seesFullDealerIds } from "@/lib/kyc/dealerIdMask";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

export async function GET(_req: NextRequest, context: RouteContext) {
  // ID 166 item 11: Admin and the dealer account's owner read too.
  const auth = await requireDealerValidationReader((await context.params).dealerId);
  if (!auth.ok) return auth.response;

  try {
    const { dealerId } = await context.params;

    const rows = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    const application = rows[0];
    if (!application) {
      return NextResponse.json(
        { success: false, message: "Dealer application not found" },
        { status: 404 }
      );
    }

    const raw = await classifyGstinConflict(application);
    // ID 119-A: the clashing account belongs to ANOTHER dealer. Its PAN goes in
    // full only to Admin, CEO and Sales Head; an owner (ISR, ASM, Sales
    // Executive, Sales Manager, Business Head) gets the last 4, in the summary
    // and inside the message text alike.
    const classification = seesFullDealerIds(auth.user.role)
      ? raw
      : {
          ...raw,
          existing: raw.existing ? maskDealerIdsDeep(raw.existing, false) : null,
          message: maskIdsInText(raw.message, false),
        };

    return NextResponse.json({
      success: true,
      dealerId: application.id,
      isBranchDealer: application.is_branch_dealer,
      ...classification,
    });
  } catch (error: any) {
    console.error("DUPLICATE CHECK ERROR:", error);
    return NextResponse.json(
      { success: false, message: "Failed to classify duplicate" },
      { status: 500 }
    );
  }
}
