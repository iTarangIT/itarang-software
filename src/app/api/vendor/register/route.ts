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
 * WHAT STOPS A STRANGER GETTING YOUR DEALERS' DATA. Nothing here vets anybody,
 * so the role lands PENDING, and listRoutableVendors() only ever routes a deal
 * to a vendor whose business_entity_roles row is ACTIVE (it joins on it — this
 * is not a UI check). A registrant can log in immediately and see an empty
 * dashboard; they cannot receive a quotation, and a quotation is the only thing
 * that carries battery details or a pickup city. The gate was already in the
 * right place before this route existed, which is why this route is safe to be
 * public.
 *
 * The three-row entity (accounts + business_entity_roles + scrap_vendors) is the
 * same shape POST /api/admin/buyback/vendors writes — a self-registered vendor
 * is not a different kind of vendor, just an unvetted one. The differences are
 * `status: PENDING` and `onboarding_status: 'vendor_self'`, so an admin can tell
 * who walked in off the street from who they invited.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";

import { generateId, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { accounts, businessEntityRoles, scrapVendors, users } from "@/lib/db/schema";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { hashPassword } from "@/lib/auth/hashPassword";
import { HttpError, ValidationError } from "@/lib/buyback/errors";
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
  pan: z.string().trim().length(10).optional(),
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
  // retries. The reverse (DB rows with no way to sign in) is not recoverable by
  // them at all.
  const { data: created, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: body.password,
    email_confirm: true,
    // MUST be set here. The middleware reads the role off the JWT's app_metadata
    // and falls back to user_metadata; the RDS role only reaches the JWT after
    // /api/user/profile has run once. Without this a brand-new vendor resolves
    // to "user" on their very first navigation and gets bounced to "/".
    user_metadata: { role: "scrap_vendor" },
  });

  if (authError || !created?.user?.id) {
    throw new ValidationError(
      authError?.message ?? "Could not create your login. Try again in a moment.",
    );
  }

  const authUserId = created.user.id;

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
      // PENDING — nobody has vetted this firm. The admin route writes ACTIVE
      // because an admin adding a vendor HAS vetted them; here there is no such
      // claim. listRoutableVendors() joins on ACTIVE, so until an admin
      // approves, this vendor cannot be routed a single deal.
      status: "PENDING",
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

  return successResponse(
    {
      ...vendor,
      email,
      // The UI says this out loud. A vendor who registers, logs in and finds an
      // empty dashboard with no explanation concludes the portal is broken.
      status: "PENDING",
      message:
        "Your login is ready. An iTarang admin will review your details before you start receiving battery lots.",
    },
    201,
  );
});
