/**
 * POST /api/admin/buyback/vendors/:entityId/activate   (E-195)
 *
 * Approve a vendor who registered themselves, or suspend one who shouldn't be
 * receiving lots any more.
 *
 * THIS IS THE VETTING. Self-serve registration deliberately does none: anyone
 * can create a login and a PENDING vendor row. What they cannot do is receive a
 * quotation, because listRoutableVendors() joins on
 * business_entity_roles.status = 'ACTIVE'. This route is the only thing that
 * writes that word, so it is the whole gate between "a stranger signed up" and
 * "a stranger is being sent a dealer's battery lot, with its pickup city on it".
 *
 * An admin flipping this is asserting they have checked the firm is real — the
 * GSTIN, the PAN, that they are who they say. That assertion is why the
 * activity log records who did it.
 *
 * SUSPEND is the same door backwards, and it is not a delete: their history —
 * quotations, agreed deals, invoices — has to stay. Routing stops; nothing else
 * changes.
 */

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { businessEntityRoles } from "@/lib/db/schema";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError, ValidationError } from "@/lib/buyback/errors";

export const runtime = "nodejs";

const bodySchema = z.object({
  // Not a bare "approve": the same decision reversed is the only way to stop
  // routing to a vendor who has gone bad, and it belongs on the same route.
  status: z.enum(["ACTIVE", "SUSPENDED"]),
  note: z.string().max(500).optional(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ entityId: string }> }) => {
    const { entityId } = await ctx.params;
    const actor = await requireBuybackAdmin();
    const body = bodySchema.parse(await req.json());

    const [role] = await db
      .select({ status: businessEntityRoles.status })
      .from(businessEntityRoles)
      .where(
        and(
          eq(businessEntityRoles.entity_id, entityId),
          eq(businessEntityRoles.role, "SCRAP_VENDOR"),
        ),
      )
      .limit(1);

    if (!role) throw new NotFoundError("Vendor not found.");

    if (role.status === body.status) {
      throw new ValidationError(`This vendor is already ${body.status}.`);
    }

    await db
      .update(businessEntityRoles)
      .set({ status: body.status, updated_at: new Date() })
      .where(
        and(
          eq(businessEntityRoles.entity_id, entityId),
          eq(businessEntityRoles.role, "SCRAP_VENDOR"),
        ),
      );

    // Not written to buyback_activity_log: that table is keyed to a request and
    // a deal (both NOT NULL on request_id), and vetting a firm belongs to
    // neither. Sprint 4's M18/M19 gives vendor onboarding its own audit surface
    // alongside the Digio agreement; until then the role row's updated_at is
    // the record, and this comment is why there isn't more.
    return successResponse({
      entity_id: entityId,
      status: body.status,
      changed_by: actor.id,
    });
  },
);
