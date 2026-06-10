import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
  users,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "@/lib/supabase/server";

type RouteContext = {
  params: Promise<{ applicationId: string }>;
};

// Internal staff who may open ANY application in the wizard — e.g. continuing a
// converted lead (BRD §0.13) they didn't personally create. Everyone else may
// only open an application they OWN (dealer_user_id === their id), matching the
// owner-scoped "My Drafts" list (/api/dealer-onboarding/my). Without the
// ownership branch, a draft owner whose role isn't internal (e.g. the dedicated
// "onboarding" role) gets 403 resuming their own draft, so its saved documents
// never reload.
const INTERNAL_ROLES = ["admin", "sales_head", "ceo", "inside_sales_rep", "asm"];

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
    const isInternal = !!dbUser && INTERNAL_ROLES.includes(dbUser.role);

    const { applicationId } = await context.params;

    const application =
      (
        await db
          .select()
          .from(dealerOnboardingApplications)
          .where(eq(dealerOnboardingApplications.id, applicationId))
          .limit(1)
      )[0] ?? null;

    // Authorize: internal staff may open any application; everyone else only
    // their own. Checked after the fetch so the owner test can use the row.
    if (application && !isInternal && application.dealer_user_id !== user.id) {
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
