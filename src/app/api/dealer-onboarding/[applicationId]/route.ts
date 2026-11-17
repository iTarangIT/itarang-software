import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
  users,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "@/lib/supabase/server";
import { mayOpenOnboardingApplication } from "@/lib/auth/dealerValidationRules";

type RouteContext = {
  params: Promise<{ applicationId: string }>;
};


export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }
    const dbUser = (
      await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)
    )[0];

    const { applicationId } = await context.params;

    const application =
      (
        await db
          .select()
          .from(dealerOnboardingApplications)
          .where(eq(dealerOnboardingApplications.id, applicationId))
          .limit(1)
      )[0] ?? null;

    // Authorize (mayOpenOnboardingApplication): Admin / Sales Head / CEO any
    // application; ASM / ISR only a draft (17 Nov: a submitted application is
    // a Dealer Validation file they do not open); everyone else only their
    // own. Checked after the fetch so the rule can use the row.
    if (
      application &&
      !mayOpenOnboardingApplication({
        role: dbUser?.role,
        userId: user.id,
        dealerUserId: application.dealer_user_id,
        onboardingStatus: application.onboarding_status,
      })
    ) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const documents = application
      ? await db
          .select()
          .from(dealerOnboardingDocuments)
          .where(eq(dealerOnboardingDocuments.application_id, applicationId))
      : [];

    return NextResponse.json({
      success: true,
      application,
      documents,
    });
  } catch (error: any) {
    console.error("GET ONBOARDING BY ID ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to fetch onboarding application",
      },
      { status: 500 }
    );
  }
}
