/**
 * POST /api/admin/buyback/vendors/:entityId/credentials — re-send a vendor
 * their generated portal password (E-223).
 *
 * The recovery path for the only way admin onboarding can half-fail: the vendor
 * and their documents were written, but the credentials email bounced, so
 * issueVendorCredentials left the role PENDING. Without this route that vendor
 * is a trapdoor — visible in the DB, invisible to routing, and unfixable from
 * the UI.
 *
 * NOT the same thing as POST .../:entityId/activate. That route is the
 * vetting/suspension lever: an admin asserting a firm is real (or has gone
 * bad), which is a judgement. This one asserts nothing — it re-runs a delivery
 * that failed, and activation follows only if the mail actually leaves.
 *
 * Refuses when the vendor is already ACTIVE. A vendor who is signed in and
 * working would have their password silently reset out from under them, and the
 * admin clicking this cannot see that. Deactivate first if that is really the
 * intent.
 */

import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { accounts, businessEntityRoles } from "@/lib/db/schema";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";
import { issueVendorCredentials } from "@/lib/buyback/vendor-credentials";

export const runtime = "nodejs";

export const POST = withErrorHandler(
  async (req: NextRequest, ctx: { params: Promise<{ entityId: string }> }) => {
    const { entityId } = await ctx.params;
    await requireBuybackAdmin();

    const [vendor] = await db
      .select({
        status: businessEntityRoles.status,
        name: accounts.business_entity_name,
        email: accounts.contact_email,
        contact_name: accounts.contact_name,
      })
      .from(businessEntityRoles)
      .innerJoin(accounts, eq(accounts.id, businessEntityRoles.entity_id))
      .where(
        and(
          eq(businessEntityRoles.entity_id, entityId),
          eq(businessEntityRoles.role, "SCRAP_VENDOR"),
        ),
      )
      .limit(1);

    if (!vendor) throw new NotFoundError("Vendor not found.");

    if (vendor.status === "ACTIVE") {
      throw new ValidationError(
        "This vendor is already active — re-sending would reset a working password. Suspend them first if that is what you want.",
      );
    }

    if (!vendor.email) {
      throw new ValidationError(
        "This vendor has no contact email, so there is nowhere to send their login.",
      );
    }

    const result = await issueVendorCredentials(
      {
        entityId,
        email: vendor.email,
        contactName: vendor.contact_name || vendor.name,
        vendorName: vendor.name,
      },
      { loginUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin}/login` },
    );

    return successResponse({
      entity_id: entityId,
      status: result.dispatched ? "ACTIVE" : "PENDING",
      credential: result,
    });
  },
);
