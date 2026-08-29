/**
 * POST /api/vendor/register   (E-195, BRD M24 — self-serve vendor sign-up)
 *
 * PUBLIC. No session required — that is the point: a recycler who wants to buy
 * end-of-life batteries from iTarang can register themselves instead of waiting
 * for an admin to type them in.
 *
 * DELIBERATELY LITE. Email + password + who you are. No GST/PAN verification, no
 * Digio agreement, no document upload — that is M18/M19, and gating sign-up on
 * it would just recreate the admin-types-it-in bottleneck this removes.
 *
 * VISIBILITY. A self-registered vendor lands ACTIVE (product decision — no
 * approval step): listRoutableVendors() joins on business_entity_roles.status =
 * 'ACTIVE', so the vendor appears in the admin's routing picker immediately.
 * The admin still chooses which vendors a given quotation is emailed to, so the
 * decision to expose a lot's battery details / pickup city to a firm is made at
 * routing time, per deal — not by a blanket gate. This route is public, so
 * anyone can create a login; what they cannot do is pull a quotation to
 * themselves — only an admin sends one.
 *
 * The three-row entity (accounts + business_entity_roles + scrap_vendors) is the
 * same shape POST /api/admin/buyback/vendors writes — a self-registered vendor
 * is not a different kind of vendor. `onboarding_status: 'vendor_self'` still
 * marks who walked in off the street from who we invited.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";

import { generateId, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { accounts, businessEntityRoles, scrapVendors, users } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/hashPassword";
import { createOrAdoptVendorAuthUser } from "@/lib/buyback/vendor-auth";
import { HttpError, ValidationError } from "@/lib/buyback/errors";
import { notifyVendorRegistered } from "@/lib/notifications/events";
import { CHEMISTRIES } from "@/lib/buyback/line-spec";

export const runtime = "nodejs";

const bodySchema = z.object({
  // --- the login ---
  email: z.string().email().max(255),
  password: z.string().min(8, "Use at least 8 characters.").max(200),
  contact_name: z.string().trim().min(2).max(120),

  // --- the firm ---
  name: z.string().trim().min(2).max(200),
  // GSTIN is NOT NULL on accounts, and a vendor we cannot invoice is a vendor we
  // cannot sell to — so it is asked for now rather than patched in later. It is
  // NOT verified here; that is M18.
  gstin: z.string().trim().length(15, "A GSTIN is 15 characters."),
  // PAN is OPTIONAL supplementary data at self-registration, not a gate — GSTIN
  // is what we invoice against. A strict length(10) hard-blocked a vendor from
  // creating a login over a non-critical field (and reported it as a cryptic
  // "too small"). Kept lenient here; a proper PAN check belongs in admin
  // activation / KYC, not in the door.
  pan: z.string().trim().max(10).optional(),
  contact_phone: z.string().trim().min(8).max(20).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),

  // --- what they want ---
  categories: z.array(z.enum(CHEMISTRIES)).default([]),
  regions: z.array(z.string().trim().min(1).max(120)).default([]),
});

export const POST = withErrorHandler(async (req: Request) => {
  const body = bodySchema.parse(await req.json());
  const email = body.email.trim().toLowerCase();

  // A GSTIN identifies a firm. Two logins for one GSTIN is a real thing (two
  // buyers at the same recycler) but it is not something to guess at during
  // sign-up — refuse, and let an admin decide.
  const [existingFirm] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.gstin, body.gstin))
    .limit(1);

  if (existingFirm) {
    throw new HttpError(
      "A business with this GSTIN is already registered with iTarang. Contact us and we'll link your login to it.",
      409,
    );
  }

  const [existingLogin] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existingLogin) {
    // Says an account exists, not what kind. This endpoint is public, so it is
    // an email-enumeration surface either way — but there is no reason to also
    // disclose whether that address belongs to a dealer or our own staff.
    throw new HttpError("An account already exists for this email address.", 409);
  }

  // The Supabase auth user FIRST, outside the transaction: it is the one thing
  // here we cannot roll back. If the DB write below fails, we are left with an
  // orphan auth user and no login rows — recoverable, and the registrant simply
  // retries (createOrAdoptVendorAuthUser then ADOPTS the orphan). The reverse
  // (DB rows with no way to sign in) is not recoverable by them at all.
  const authUserId = await createOrAdoptVendorAuthUser(email, body.password);

  const vendor = await db.transaction(async (tx) => {
    const entityId = await generateId("VND");

    await tx.insert(accounts).values({
      id: entityId,
      business_entity_name: body.name,
      gstin: body.gstin,
      pan: body.pan ?? null,
      contact_email: email,
      contact_phone: body.contact_phone ?? null,
      city: body.city ?? null,
      state: body.state ?? null,
      status: "active",
      // 'vendor_self' vs the admin route's 'vendor_manual': who walked in off
      // the street, and who we invited. An admin approving these wants to know.
      onboarding_status: "vendor_self",
      created_by: authUserId,
    });

    await tx.insert(businessEntityRoles).values({
      entity_id: entityId,
      role: "SCRAP_VENDOR",
      // ACTIVE on sign-up (product decision — no approval step). A
      // self-registered vendor is immediately routable, so an admin sees them
      // in the routing picker straight away. Vetting now happens implicitly
      // when the admin CHOOSES whom to email a quotation to, per deal, rather
      // than via a blanket PENDING gate. onboarding_status='vendor_self' still
      // marks who walked in off the street vs. who we invited.
      status: "ACTIVE",
    });

    const [row] = await tx
      .insert(scrapVendors)
      .values({
        entity_id: entityId,
        categories: body.categories,
        regions: body.regions,
        created_by: authUserId,
      })
      .returning({ id: scrapVendors.id });

    if (!row) throw new ValidationError("Your vendor profile could not be created.");

    await tx.insert(users).values({
      id: authUserId,
      email,
      name: body.contact_name,
      role: "scrap_vendor",
      phone: body.contact_phone ?? null,
      // The link E-195 exists for. NOT dealer_id — see that migration.
      vendor_entity_id: entityId,
      // They chose this password themselves, so there is nothing to force them
      // to change. `password_hash` mirrors the dealer/NBFC rows; Supabase holds
      // the credential that actually authenticates.
      password_hash: await hashPassword(body.password),
      must_change_password: false,
      is_active: true,
    });

    return { vendor_id: row.id, entity_id: entityId };
  });

  // Vendors self-register with no approval step (see the comment on the
  // businessEntityRoles insert above), so this is the only way an admin finds
  // out a new vendor exists and is routable.
  await notifyVendorRegistered({ vendorName: body.name, vendorId: vendor.vendor_id });

  return successResponse(
    {
      ...vendor,
      email,
      status: "ACTIVE",
      message:
        "Your login is ready. iTarang can now send you battery lots as they come up.",
    },
    201,
  );
});
