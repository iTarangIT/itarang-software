/**
 * GET  /api/admin/buyback/vendors  — vendors that can be routed to
 * POST /api/admin/buyback/vendors  — onboard a scrap vendor (minimal, M18-lite)
 *
 * A vendor is not a new kind of entity. It is an `accounts` row — the CRM's
 * existing entity + KYC store — plus a `business_entity_roles` row saying that
 * entity plays the SCRAP_VENDOR role, plus a `scrap_vendors` row holding what is
 * genuinely vendor-specific (what they buy, where they collect, how they pay).
 * All three are written in one transaction: a vendor that exists as an account
 * but has no role would be invisible to routing, which is a confusing half-state
 * for an admin to land in.
 *
 * SCOPE: this is deliberately M18-LITE. Full vendor onboarding — GST/PAN
 * verification and the Digio agreement — is M18/M19 in Sprint 4. Routing filters
 * on `business_entity_roles.status = 'ACTIVE'`, so when Sprint 4 makes ACTIVE
 * mean "agreement signed", M18's AC ("unonboarded vendor unselectable for
 * routing") starts holding without this route or the routing query changing.
 */

import { z } from "zod";

import { generateId, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { accounts, businessEntityRoles, scrapVendors } from "@/lib/db/schema";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { ValidationError } from "@/lib/buyback/errors";
import { listRoutableVendors } from "@/lib/buyback/vendors";

export const runtime = "nodejs";

export const GET = withErrorHandler(async () => {
  await requireBuybackAdmin();
  const vendors = await listRoutableVendors();

  return successResponse({
    vendors: vendors.map((v) => ({
      id: v.id,
      name: v.name,
      email: v.email,
      phone: v.phone,
      city: v.city,
      state: v.state,
      categories: v.categories,
      regions: v.regions,
      payment_terms: v.payment_terms,
    })),
  });
});

const bodySchema = z.object({
  name: z.string().min(2),
  // GSTIN is NOT NULL on accounts, and a scrap vendor without one cannot be
  // invoiced — so it is required here rather than patched in later.
  gstin: z.string().length(15),
  pan: z.string().length(10).optional(),
  contact_email: z.string().email(),
  contact_phone: z.string().min(8).max(20).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  categories: z.array(z.string()).default([]),
  regions: z.array(z.string()).default([]),
  payment_terms: z.string().optional(),
  credit_limit: z.number().nonnegative().optional(),
});

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireBuybackAdmin();
  const body = bodySchema.parse(await req.json());

  const vendor = await db.transaction(async (tx) => {
    const entityId = await generateId("VND");

    await tx.insert(accounts).values({
      id: entityId,
      business_entity_name: body.name,
      gstin: body.gstin,
      pan: body.pan ?? null,
      contact_email: body.contact_email,
      contact_phone: body.contact_phone ?? null,
      city: body.city ?? null,
      state: body.state ?? null,
      status: "active",
      // Not a dealer: no onboarding wizard, no KYC docs, no facilitation fee.
      onboarding_status: "vendor_manual",
      created_by: actor.id,
    });

    await tx.insert(businessEntityRoles).values({
      entity_id: entityId,
      role: "SCRAP_VENDOR",
      // Sprint 4 (M18/M19) will make this PENDING until an agreement is signed.
      // Until that exists, an admin adding a vendor means they have vetted them.
      status: "ACTIVE",
    });

    const [row] = await tx
      .insert(scrapVendors)
      .values({
        entity_id: entityId,
        categories: body.categories,
        regions: body.regions,
        payment_terms: body.payment_terms ?? null,
        credit_limit: body.credit_limit?.toString() ?? null,
        created_by: actor.id,
      })
      .returning({ id: scrapVendors.id });

    if (!row) throw new ValidationError("Vendor could not be created.");

    return { id: row.id, entity_id: entityId, name: body.name };
  });

  return successResponse(vendor, 201);
});
