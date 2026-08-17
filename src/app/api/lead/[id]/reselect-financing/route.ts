/**
 * POST /api/lead/[id]/reselect-financing
 *
 * E-241 — route this lead to ANOTHER lender after the dealer closed a deal
 * (POST /api/lead/[id]/close-offer).
 *
 * Step 4 is read-only once submitted (`step-4-access` returns readOnly), and it
 * should stay that way: re-opening the wizard would put the battery serial, the
 * pricing and the photos back in play when all that changed is which lender the
 * customer wants. So this is a narrow second writer of nbfc_lead_assignments —
 * one lead, one extra NBFC, nothing else touched.
 *
 * Trust boundary: the client sends an nbfcId + loanProductId it read from
 * /section-g-options, and this route re-runs the SAME BRE match server-side and
 * refuses a pair the engine does not actually return. The options endpoint is a
 * read; without this check a dealer could bind the lead to any product id.
 *
 * Role: dealer, owning this lead. Body: { nbfcId, loanProductId }.
 */
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  dealers,
  leads,
  nbfc,
  nbfcLeadAssignments,
  nbfcLoanProducts,
  nbfcServiceConfig,
  productCategories,
  productSelections,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import {
  loadActiveProductsForDealer,
  matchProducts,
  type CustomerProfile,
} from "@/lib/bre";
import { buildServiceSnapshot } from "@/lib/nbfc/service-snapshot";
import { notifyLeadRerouted } from "@/lib/notifications/events";
import { dealerDisplayName } from "@/lib/notifications/emit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Addendum §5.2 — a lead may sit with at most two lenders at once. */
const MAX_LIVE_ASSIGNMENTS = 2;

/** Assignment states that no longer occupy one of those two slots. */
const FREED_STATUSES = new Set(["withdrawn", "not_selected", "declined"]);

const Body = z.object({
  nbfcId: z.union([z.number(), z.string()]),
  loanProductId: z.union([z.number(), z.string()]),
});

const bad = (message: string, status = 400) =>
  NextResponse.json({ success: false, error: { message } }, { status });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return bad("Invalid JSON");
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? "Invalid request");

    const nbfcId = Number(parsed.data.nbfcId);
    const loanProductId = Number(parsed.data.loanProductId);
    if (!Number.isFinite(nbfcId)) return bad("nbfcId required");
    if (!Number.isFinite(loanProductId)) return bad("loanProductId required");

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) return bad("Lead not found", 404);
    if (lead.dealer_id !== user.dealer_id) return bad("Access denied", 403);
    if (String(lead.payment_method || "").toLowerCase() === "cash") {
      return bad("This is a cash lead — there is no lender to route it to.");
    }

    const assignments = await db
      .select({
        id: nbfcLeadAssignments.id,
        nbfc_id: nbfcLeadAssignments.nbfc_id,
        status: nbfcLeadAssignments.status,
      })
      .from(nbfcLeadAssignments)
      .where(eq(nbfcLeadAssignments.lead_id, leadId));

    if (assignments.some((a) => a.status === "selected")) {
      return bad("A winning lender has already been selected for this lead.");
    }
    // Re-selection is the escape hatch from a CLOSED deal, not a way to keep
    // adding lenders. Without this the card could be reached on a fresh lead and
    // quietly bypass the Section-G picks the customer signed off on.
    if (!assignments.some((a) => a.status === "withdrawn")) {
      return bad("Close a deal first before picking another lender.");
    }
    if (assignments.some((a) => a.nbfc_id === nbfcId)) {
      return bad("This lead has already been routed to that NBFC.");
    }
    const liveCount = assignments.filter((a) => !FREED_STATUSES.has(a.status)).length;
    if (liveCount >= MAX_LIVE_ASSIGNMENTS) {
      return bad(
        `This lead is already with ${MAX_LIVE_ASSIGNMENTS} lenders. Close one of those deals before adding another.`,
      );
    }

    // ---- Re-run the Section G match server-side -----------------------------
    if (!user.dealer_id) return bad("Your account is not linked to a dealer.");
    const [dealerRow] = await db
      .select({ id: dealers.id })
      .from(dealers)
      .where(eq(dealers.dealer_id, user.dealer_id))
      .limit(1);
    if (!dealerRow) return bad("Your account is not linked to a dealer.");

    // The loan amount narrows the match to amount-eligible products, exactly as
    // the Section G submit re-fetch does. Read off the submitted selection so it
    // is the price the customer actually agreed to, not one posted by the client.
    // Newest first — a re-submitted Step 4 leaves the older row behind, and the
    // stale price would silently narrow the match to the wrong band.
    const [selection] = await db
      .select({ final_price: productSelections.final_price })
      .from(productSelections)
      .where(eq(productSelections.lead_id, leadId))
      .orderBy(desc(productSelections.created_at))
      .limit(1);
    const loanAmount = selection?.final_price != null ? Number(selection.final_price) : null;

    let batteryCategoryName: string | null = null;
    if (lead.product_category_id) {
      const [categoryRow] = await db
        .select({ name: productCategories.name })
        .from(productCategories)
        .where(eq(productCategories.id, lead.product_category_id))
        .limit(1);
      batteryCategoryName = categoryRow?.name ?? null;
    }

    const customer: CustomerProfile = {
      battery_category: batteryCategoryName,
      state: lead.state ?? null,
      city: lead.city ?? null,
      loan_amount: Number.isFinite(loanAmount) ? loanAmount : null,
      credit_score: null,
      resident_status:
        lead.resident_status === "owned" || lead.resident_status === "rented"
          ? lead.resident_status
          : null,
    };

    const products = await loadActiveProductsForDealer(dealerRow.id);
    const { hits } = matchProducts(customer, products);
    const hit = hits.find((h) => h.product_id === loanProductId && h.nbfc_id === nbfcId);
    if (!hit) {
      return bad(
        "That loan product is no longer available for this lead. Refresh the list and pick again.",
      );
    }

    // ---- Bind ---------------------------------------------------------------
    const [nbfcRow] = await db
      .select({ id: nbfc.id, tenant_id: nbfc.tenant_id })
      .from(nbfc)
      .where(eq(nbfc.id, nbfcId))
      .limit(1);
    if (!nbfcRow?.tenant_id) {
      // Same failure mode submit-product-selection warns about: an nbfc row with
      // no tenant binding never surfaces in an Acquire queue, so routing to it
      // would silently strand the lead.
      return bad("That NBFC is not set up to receive leads. Pick another lender.");
    }

    const [cfg] = await db
      .select()
      .from(nbfcServiceConfig)
      .where(eq(nbfcServiceConfig.tenant_id, nbfcRow.tenant_id))
      .limit(1);

    const now = new Date();

    await db.transaction(async (tx) => {
      await tx
        .insert(nbfcLeadAssignments)
        .values({
          lead_id: leadId,
          nbfc_id: nbfcId,
          tenant_id: nbfcRow.tenant_id as string,
          loan_product_id: loanProductId,
          status: "pending",
          service_config_snapshot: buildServiceSnapshot(cfg, now),
        })
        .onConflictDoNothing({
          target: [nbfcLeadAssignments.lead_id, nbfcLeadAssignments.nbfc_id],
        });

      // Keep product_selections.selected_nbfcs in step — the dossier and the
      // admin product review read the picks from there, not from assignments.
      // MERGE, never replace: the closed lender stays on the record of what the
      // customer was shown.
      const [row] = await tx
        .select({ id: productSelections.id, selected_nbfcs: productSelections.selected_nbfcs })
        .from(productSelections)
        .where(eq(productSelections.lead_id, leadId))
        .orderBy(desc(productSelections.created_at))
        .limit(1);
      if (row) {
        const existing = Array.isArray(row.selected_nbfcs) ? row.selected_nbfcs : [];
        await tx
          .update(productSelections)
          .set({
            selected_nbfcs: [
              ...existing,
              { nbfc_id: String(nbfcId), loan_product_id: String(loanProductId) },
            ],
            updated_at: now,
          })
          .where(eq(productSelections.id, row.id));
      }
    });

    // Best-effort — a failed notification must not un-route the lead.
    try {
      const [meta] = await db
        .select({
          name: nbfc.legal_name,
          short: nbfc.short_name,
          product: nbfcLoanProducts.product_name,
        })
        .from(nbfc)
        .leftJoin(nbfcLoanProducts, eq(nbfcLoanProducts.id, loanProductId))
        .where(eq(nbfc.id, nbfcId))
        .limit(1);
      await notifyLeadRerouted({
        leadId,
        nbfcTenantId: nbfcRow.tenant_id as string,
        nbfcName: meta?.short || meta?.name || "the lender",
        loanProduct: meta?.product ?? null,
        dealerName: await dealerDisplayName(user.dealer_id),
      });
    } catch (err) {
      console.error("[reselect-financing] notification failed:", err);
    }

    return NextResponse.json({
      success: true,
      data: { leadId, nbfcId, loanProductId, assignmentStatus: "pending" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to route to that lender";
    console.error("[reselect-financing] error:", error);
    const status =
      typeof (error as { status?: unknown })?.status === "number"
        ? (error as { status: number }).status
        : 500;
    return NextResponse.json({ success: false, error: { message } }, { status });
  }
}
