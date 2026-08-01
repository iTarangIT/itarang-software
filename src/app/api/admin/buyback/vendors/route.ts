/**
 * GET  /api/admin/buyback/vendors  — vendors that can be routed to
 * POST /api/admin/buyback/vendors  — onboard a scrap vendor (E-223)
 *
 * A vendor is not a new kind of entity. It is an `accounts` row — the CRM's
 * existing entity + KYC store — plus a `business_entity_roles` row saying that
 * entity plays the SCRAP_VENDOR role, plus a `scrap_vendors` row holding what is
 * genuinely vendor-specific (what they buy, where they collect, how they pay).
 * All three are written in one transaction: a vendor that exists as an account
 * but has no role would be invisible to routing, which is a confusing half-state
 * for an admin to land in.
 *
 * E-223 REPLACED THE M18-LITE VERSION OF THIS ROUTE. It used to take seven
 * fields and land the role ACTIVE with no login at all. It now backs a real
 * onboarding form: a registered address, three mandatory documents (GST
 * certificate, PAN card, Udyam certificate), an optional manually signed
 * agreement, and a generated portal password emailed to the vendor.
 *
 * THE LIFECYCLE, AND WHY IT IS SHAPED THIS WAY.
 *   1. The three rows are written with the role PENDING.
 *   2. issueVendorCredentials mints a password, provisions the login, emails it,
 *      and flips the role to ACTIVE **only if the mail actually left**.
 * So PENDING is not a review queue — everything an admin has to check is
 * already on the form — it is the durable state of "created but unreachable",
 * and the list page offers a retry from there. Marking a vendor ACTIVE who
 * never got their password would route them a dealer's battery lot, pickup city
 * and all, that they cannot even see.
 *
 * A FAILED EMAIL IS STILL A 201. The vendor, their documents and their address
 * are real and persisted; only delivery failed. Returning 500 would tell the
 * admin nothing was created and invite them to type it all in again.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { generateId, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import {
  accounts,
  businessEntityRoles,
  scrapVendorDocuments,
  scrapVendors,
} from "@/lib/db/schema";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { HttpError, ValidationError } from "@/lib/buyback/errors";
import { CHEMISTRIES } from "@/lib/buyback/line-spec";
import { issueVendorCredentials } from "@/lib/buyback/vendor-credentials";
import { REQUIRED_VENDOR_DOC_TYPES, VENDOR_DOC_LABELS } from "@/lib/buyback/vendor-docs";
import { listPendingVendors, listRoutableVendors } from "@/lib/buyback/vendors";
import { notifyVendorRegistered } from "@/lib/notifications/events";

export const runtime = "nodejs";

export const GET = withErrorHandler(async (req: Request) => {
  await requireBuybackAdmin();

  // `?status=pending` — vendors whose credentials email has not landed (E-223),
  // plus anyone still awaiting vetting. Default stays the routable list, so
  // every existing caller (the routing picker) is unchanged: it must never
  // offer an unvetted vendor, and a "helpful" widening here would leak dealers'
  // battery details to whoever signed up last.
  const status = new URL(req.url).searchParams.get("status");

  if (status === "pending") {
    const pending = await listPendingVendors();
    return successResponse({
      vendors: pending.map((v) => ({
        id: v.id,
        entity_id: v.entity_id,
        name: v.name,
        email: v.email,
        phone: v.phone,
        city: v.city,
        state: v.state,
        gstin: v.gstin,
        pan: v.pan,
        categories: v.categories,
        regions: v.regions,
        onboarding_status: v.onboarding_status,
        registered_at: v.registered_at,
        has_login: v.has_login,
        // E-223 — why they are pending, and whether a retry is the fix.
        credential_status: v.credential_status,
        credential_error: v.credential_error,
      })),
    });
  }

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

// Reused from the NBFC master schema rather than the old bare `.length(15)` —
// a 15-character string is not a GSTIN, and the vendor we cannot invoice is the
// one whose GSTIN was wrong in a way length alone could not see.
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}$/;
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;

const bodySchema = z.object({
  name: z.string().trim().min(2).max(200),
  contact_name: z.string().trim().min(2).max(120),
  // GSTIN is NOT NULL on accounts, and a scrap vendor without one cannot be
  // invoiced — so it is required here rather than patched in later.
  gstin: z.string().trim().length(15).regex(GSTIN_RE, "That is not a valid GSTIN."),
  // Required on THIS route, unlike the public /api/vendor/register (which keeps
  // PAN lenient so a non-critical field cannot block a sign-up). An admin
  // onboarding a vendor is already demanding the PAN card as a document; asking
  // for the number it shows is not an extra burden.
  pan: z.string().trim().length(10).regex(PAN_RE, "That is not a valid PAN."),
  udyam_number: z.string().trim().max(30).optional(),

  contact_email: z.string().email().max(255),
  contact_phone: z.string().trim().min(8).max(20).optional(),

  address_line1: z.string().trim().min(1).max(255),
  address_line2: z.string().trim().max(255).optional(),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().min(1).max(120),
  pincode: z.string().trim().regex(/^\d{6}$/, "A pincode is 6 digits."),

  categories: z.array(z.enum(CHEMISTRIES)).default([]),
  regions: z.array(z.string().trim().min(1).max(120)).default([]),
  payment_terms: z.string().trim().max(120).optional(),
  credit_limit: z.number().nonnegative().optional(),

  agreement_ref: z.string().trim().max(120).optional(),
  agreement_signed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

  // Document ROW IDS, never storage keys — see the uploads route for why.
  document_ids: z.object({
    GSTIN: z.string().uuid(),
    PAN: z.string().uuid(),
    UDYAM: z.string().uuid(),
    AGREEMENT: z.string().uuid().optional(),
  }),
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const actor = await requireBuybackAdmin();
  const body = bodySchema.parse(await req.json());
  const email = body.contact_email.trim().toLowerCase();

  // A GSTIN identifies a firm. Two logins for one GSTIN is a real thing (two
  // buyers at the same recycler) but it is not something to guess at here —
  // refuse, and let a human decide which entity is the real one.
  const [existingFirm] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.gstin, body.gstin))
    .limit(1);

  if (existingFirm) {
    throw new HttpError(
      `A business with GSTIN ${body.gstin} is already on iTarang (${existingFirm.id}). Add the vendor role to that entity instead of creating a second one.`,
      409,
    );
  }

  // Resolve the uploaded documents BEFORE writing anything. Each must exist, be
  // unclaimed, and be the type the form says it is — otherwise a mis-sent id
  // would file a PAN card under "Udyam certificate" and the vendor's compliance
  // record would be quietly wrong.
  const requested = Object.entries(body.document_ids).filter(([, id]) => Boolean(id)) as Array<
    [string, string]
  >;

  const docRows = await db
    .select({
      id: scrapVendorDocuments.id,
      doc_type: scrapVendorDocuments.doc_type,
    })
    .from(scrapVendorDocuments)
    .where(
      and(
        inArray(
          scrapVendorDocuments.id,
          requested.map(([, id]) => id),
        ),
        // Claimed documents belong to a vendor already. Re-using one would move
        // another vendor's certificate onto this record.
        isNull(scrapVendorDocuments.entity_id),
      ),
    );

  const byId = new Map(docRows.map((d) => [d.id, d.doc_type]));
  for (const [expectedType, id] of requested) {
    const actualType = byId.get(id);
    if (!actualType) {
      throw new ValidationError(
        `The ${VENDOR_DOC_LABELS[expectedType as keyof typeof VENDOR_DOC_LABELS]} upload has expired or was already used. Re-attach it and try again.`,
      );
    }
    if (actualType !== expectedType) {
      throw new ValidationError(
        `A document was attached under the wrong heading (${actualType} sent as ${expectedType}). Re-attach it and try again.`,
      );
    }
  }

  for (const type of REQUIRED_VENDOR_DOC_TYPES) {
    if (!body.document_ids[type]) {
      throw new ValidationError(`The ${VENDOR_DOC_LABELS[type]} is required.`);
    }
  }

  const vendor = await db.transaction(async (tx) => {
    const entityId = await generateId("VND");

    await tx.insert(accounts).values({
      id: entityId,
      business_entity_name: body.name,
      gstin: body.gstin,
      pan: body.pan,
      contact_name: body.contact_name,
      contact_email: email,
      contact_phone: body.contact_phone ?? null,
      address_line1: body.address_line1,
      address_line2: body.address_line2 ?? null,
      city: body.city,
      state: body.state,
      pincode: body.pincode,
      status: "active",
      // Not a dealer: no onboarding wizard, no facilitation fee. 'vendor_manual'
      // vs the public route's 'vendor_self' still marks who we invited from who
      // walked in off the street.
      onboarding_status: "vendor_manual",
      created_by: actor.id,
    });

    await tx.insert(businessEntityRoles).values({
      entity_id: entityId,
      role: "SCRAP_VENDOR",
      // PENDING until the credentials email lands — see the file header.
      status: "PENDING",
    });

    const [row] = await tx
      .insert(scrapVendors)
      .values({
        entity_id: entityId,
        categories: body.categories,
        regions: body.regions,
        payment_terms: body.payment_terms ?? null,
        credit_limit: body.credit_limit?.toString() ?? null,
        udyam_number: body.udyam_number ?? null,
        agreement_ref: body.agreement_ref ?? null,
        agreement_signed_on: body.agreement_signed_on ?? null,
        created_by: actor.id,
      })
      .returning({ id: scrapVendors.id });

    if (!row) throw new ValidationError("Vendor could not be created.");

    // Claim the documents. Scoped by `isNull(entity_id)` again inside the
    // transaction, not just in the read above: two admins submitting forms that
    // reference the same upload would otherwise both succeed on a check made
    // before either wrote.
    await tx
      .update(scrapVendorDocuments)
      .set({ entity_id: entityId, claimed_at: new Date() })
      .where(
        and(
          inArray(
            scrapVendorDocuments.id,
            requested.map(([, id]) => id),
          ),
          isNull(scrapVendorDocuments.entity_id),
        ),
      );

    return { id: row.id, entity_id: entityId, name: body.name };
  });

  // Outside the transaction: this provisions a Supabase auth user and sends
  // mail, neither of which a DB rollback could undo.
  const credential = await issueVendorCredentials(
    {
      entityId: vendor.entity_id,
      email,
      contactName: body.contact_name,
      vendorName: body.name,
    },
    { loginUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin}/login` },
  );

  if (credential.dispatched) {
    await notifyVendorRegistered({ vendorName: body.name, vendorId: vendor.id });
  }

  return successResponse(
    {
      ...vendor,
      status: credential.dispatched ? "ACTIVE" : "PENDING",
      credential,
    },
    201,
  );
});
