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

// Internal staff who may open a converted-lead application in the wizard
// (BRD §0.13). This endpoint returns a full application by id, so it must be
// gated — previously it had no auth at all.
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
    if (!dbUser || !INTERNAL_ROLES.includes(dbUser.role)) {
      return NextResponse.json(
        { success: false, message: "Forbidden" },
        { status: 403 }
      );
    }

    const { applicationId } = await context.params;

    const application =
      (
        await db
          .select()
          .from(dealerOnboardingApplications)
          .where(eq(dealerOnboardingApplications.id, applicationId))
          .limit(1)
      )[0] ?? null;

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
