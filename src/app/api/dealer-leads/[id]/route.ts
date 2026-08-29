// PATCH /api/dealer-leads/[id] — edit a dealer lead's identity, contact and
// location details. Backs the /leads/[id]/edit form.
//
// WHY THIS ROUTE EXISTS
//   The edit form used to PUT to /api/leads/[id]. That is a DIFFERENT ENTITY:
//   /api/leads/* is the customer/loan-application `leads` table (owner_name,
//   owner_contact, shop_address…), while /leads and its edit page read
//   `dealer_leads` (dealer_name, phone, shop_name…). A `DL-…` id never exists
//   in `leads`, so every save 404'd — and the form never checked the response,
//   so it redirected to /leads looking like it had worked. Nothing was ever
//   saved. /api/leads/[id] is correct for its own entity and is left alone.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH
//   Only profile fields. Lifecycle state is owned by guarded routes and this
//   must not become a back door around them:
//     · lead_status      — transitions are gated by canTransition() and every
//                          change writes dealer_lead_status_history + a
//                          touchpoint (src/lib/touchpoints/write.ts).
//     · interest_level   — PATCH /api/inside-sales/lead/[id]/interest-level,
//                          which audits into interest_level_overrides (E-123).
//     · current_owner_id — POST /api/admin/leads/bulk (action: reassign).
//     · current_status / final_intent_score / follow_up_history — written by
//                          the dialer and the scoring engine.
//
//   No touchpoint is written here on purpose. Touchpoints record INTERACTIONS
//   with a lead; correcting a misspelt shop name is not one, and logging it
//   would inflate the touchpoint counts BRD §0.11 reports on.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq, and, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { withErrorHandler } from "@/lib/api-utils";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";
import { normalizePhone } from "@/lib/leads/dedupe";
import {
  normalizeCity,
  normalizeState,
  inferStateFromCity,
} from "@/lib/scraper-enrichment";

export const dynamic = "force-dynamic";

// Every field optional — the form sends the whole object, but a partial patch
// is equally valid. Empty strings are treated as "clear this field" for the
// nullable columns, except the two that identify the lead.
const PatchSchema = z.object({
  dealer_name: z.string().trim().min(1, "Dealer name is required").optional(),
  phone: z.string().trim().min(1, "Phone is required").optional(),
  shop_name: z.string().trim().optional(),
  location: z.string().trim().optional(),
  state: z.string().trim().optional(),
  city: z.string().trim().optional(),
  area: z.string().trim().optional(),
  pincode: z.string().trim().optional(),
  language: z.string().trim().optional(),
  source: z.string().trim().max(40).optional(),
  overall_summary: z.string().trim().max(5000).optional(),
});

export const PATCH = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    await requireRole([...LEADS_PAGE_ROLES]);
    const { id } = await params;

    const parsed = PatchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              parsed.error.issues[0]?.message ?? "Invalid lead details.",
          },
        },
        { status: 400 },
      );
    }
    const body = parsed.data;

    const [existing] = await db
      .select({ id: dealerLeads.id, location: dealerLeads.location })
      .from(dealerLeads)
      .where(eq(dealerLeads.id, id))
      .limit(1);
    if (!existing) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    const updates: Record<string, unknown> = {};

    if (body.dealer_name !== undefined) updates.dealer_name = body.dealer_name;

    // Normalise before storing, same engine as the create route, the bulk
    // wizard and NeoDove inbound. Writing what the operator typed would make
    // "98765 43210" a different dealer from "+919876543210" to every importer.
    if (body.phone !== undefined) {
      const normalized = normalizePhone(body.phone);
      if (!normalized) {
        return NextResponse.json(
          {
            success: false,
            error: {
              message: "Enter a valid 10-digit Indian mobile number.",
            },
          },
          { status: 400 },
        );
      }
      // dealer_leads.phone is UNIQUE (dealer_leads_phone_unique). Check before
      // writing so the operator gets a sentence instead of a 500 from a
      // constraint violation.
      const [clash] = await db
        .select({ id: dealerLeads.id })
        .from(dealerLeads)
        .where(and(eq(dealerLeads.phone, normalized), ne(dealerLeads.id, id)))
        .limit(1);
      if (clash) {
        return NextResponse.json(
          {
            success: false,
            error: {
              message: `That phone number already belongs to another lead (${clash.id}).`,
            },
          },
          { status: 409 },
        );
      }
      updates.phone = normalized;
    }

    if (body.shop_name !== undefined) updates.shop_name = body.shop_name || null;
    if (body.language !== undefined) updates.language = body.language || null;
    if (body.source !== undefined) updates.source = body.source || null;
    if (body.area !== undefined) updates.area = body.area || null;
    if (body.pincode !== undefined) updates.pincode = body.pincode || null;
    if (body.overall_summary !== undefined) {
      updates.overall_summary = body.overall_summary || null;
    }

    // Region: canonicalise city/state the way the create route does, and fall
    // back to `location` as a city string so a lead edited here still shows up
    // in the region selector and the dialer's audience query.
    if (
      body.city !== undefined ||
      body.state !== undefined ||
      body.location !== undefined
    ) {
      const canonicalCity =
        normalizeCity(body.city || body.location || undefined) ?? null;
      const canonicalState =
        normalizeState(body.state || undefined) ??
        inferStateFromCity(canonicalCity) ??
        null;
      if (body.city !== undefined) updates.city = canonicalCity;
      if (body.state !== undefined) updates.state = canonicalState;
      if (body.location !== undefined) {
        updates.location = body.location || canonicalCity;
      } else if (!existing.location && canonicalCity) {
        // `location` is the legacy free-form region field and is still what the
        // lead detail page renders (`location || city`). Backfill it from the
        // city when it is EMPTY so an edited lead doesn't show a blank region —
        // but never overwrite an existing value, which may hold a fuller
        // address than the city alone.
        updates.location = canonicalCity;
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ success: true, id, updated: 0 });
    }

    updates.updated_at = new Date();
    await db.update(dealerLeads).set(updates).where(eq(dealerLeads.id, id));

    return NextResponse.json({
      success: true,
      id,
      updated: Object.keys(updates).length,
    });
  },
);
