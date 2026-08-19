import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, nbfc, nbfcLeadAssignments, nbfcLoanProducts, nbfcServiceConfig, productSelections } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { generateId } from "@/lib/api-utils";
import { notifyProductSelectionSubmitted } from "@/lib/notifications";
import { notifyProductSubmitted } from "@/lib/notifications/events";
import { dealerDisplayName } from "@/lib/notifications/emit";
import { InventoryLifecycleError } from "@/lib/inventory/lifecycle";
import {
  productSelectionColumns,
  submitProductSelectionSchema,
} from "@/lib/leads/productSelectionSchema";
import { buildServiceSnapshot } from "@/lib/nbfc/service-snapshot";

// BRD V2 §2.4 — finance path submit for Step 4.
// Stores the product selection, advances the lead to 'pending_final_approval'
// and fans the lead out to the NBFC Acquire queues.
//
// This route no longer reserves inventory, and no longer requires a battery
// serial or a price. Since the Step-4/Step-5 split it means "send this
// customer to the lenders": the NBFC underwrites the customer's profile and
// quotes an indicative range, and the dealer picks the actual stock and settles
// the price on Step 5. Reservation happens there, in the same transaction as
// dispatch (`step-5/confirm-dispatch`).
//
// The fan-out below is driven entirely by `selected_nbfcs`, never by the
// product, so routing is unaffected by an empty selection.

const BodySchema = submitProductSelectionSchema;

const FINANCE_UNLOCKED = new Set(["step_3_cleared", "kyc_approved"]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;
    const body = BodySchema.parse(await req.json());

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }

    const paymentMode = String(lead.payment_method || "").toLowerCase();
    if (paymentMode === "cash") {
      return NextResponse.json(
        { success: false, error: { message: "Use confirm-cash-sale for cash leads" } },
        { status: 400 },
      );
    }
    if (!FINANCE_UNLOCKED.has(String(lead.kyc_status))) {
      return NextResponse.json(
        { success: false, error: { message: `Lead not eligible for Step 4 (kyc_status=${lead.kyc_status})` } },
        { status: 400 },
      );
    }

    const productSelectionId = await generateId("PS");
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      // Clear any existing draft row for this lead so it disappears from
      // /My Drafts. The submitted row below replaces it as the canonical
      // selection. Done inside the transaction so partial state is impossible.
      await tx
        .delete(productSelections)
        .where(
          and(
            eq(productSelections.lead_id, leadId),
            eq(productSelections.admin_decision, "draft"),
          ),
        );

      // Insert product selection
      await tx.insert(productSelections).values({
        id: productSelectionId,
        lead_id: leadId,
        ...productSelectionColumns(body),
        category: body.category || lead.product_category_id,
        model_number: body.modelNumber || lead.product_type_id,
        payment_mode: "finance",
        admin_decision: "pending",
        pre_sanction_doc_urls: body.preSanctionDocs ?? [],
        selected_nbfcs: body.selectedNbfcs ?? [],
        customer_disclosure_ack: body.customerDisclosureAck ?? false,
        submitted_by: user.id,
        submitted_at: now,
        created_at: now,
        updated_at: now,
      });

      // Inventory is deliberately NOT reserved here — see the header comment.
      // The serial is picked on Step 5 and reserved inside confirm-dispatch.

      // Advance lead
      await tx
        .update(leads)
        .set({ kyc_status: "pending_final_approval", updated_at: now })
        .where(eq(leads.id, leadId));

      // E-131 / Addendum V0.1 §6 — fan out to NBFC Acquire queues. One row
      // per picked NBFC. tenant_id is denormalised from nbfc.tenant_id so
      // the queue page is a single tenant-scoped index hit. selected_nbfcs
      // stores nbfc.id (integer PK) as a stringified integer per the Section
      // G writer; we parseInt and drop anything non-numeric or referencing
      // an nbfc row without a tenant binding (legacy / E-026B-style rows).
      // onConflictDoNothing on (lead_id, nbfc_id) makes re-submits safe.
      if (body.selectedNbfcs && body.selectedNbfcs.length > 0) {
        const picks = body.selectedNbfcs
          .map((p) => ({
            nbfc_id: Number(p.nbfc_id),
            loan_product_id:
              p.loan_product_id == null ? null : Number(p.loan_product_id),
          }))
          .filter(
            (p) =>
              Number.isFinite(p.nbfc_id) &&
              (p.loan_product_id == null || Number.isFinite(p.loan_product_id)),
          );

        if (picks.length > 0) {
          const nbfcRows = await tx
            .select({ id: nbfc.id, tenant_id: nbfc.tenant_id })
            .from(nbfc)
            .where(inArray(nbfc.id, picks.map((p) => p.nbfc_id)));

          const tenantByNbfc = new Map(
            nbfcRows.map((r) => [r.id, r.tenant_id] as const),
          );

          // E-133 / Addendum V0.2 §7.4 — load each bound NBFC's current
          // service-opt-in config so we can freeze a per-lead snapshot.
          const tenantIds = [
            ...new Set(
              nbfcRows
                .map((r) => r.tenant_id)
                .filter((t): t is string => Boolean(t)),
            ),
          ];
          const cfgRows = tenantIds.length
            ? await tx
                .select()
                .from(nbfcServiceConfig)
                .where(inArray(nbfcServiceConfig.tenant_id, tenantIds))
            : [];
          const cfgByTenant = new Map(cfgRows.map((c) => [c.tenant_id, c] as const));

          const assignmentRows = picks
            .map((p) => {
              const tenantId = tenantByNbfc.get(p.nbfc_id);
              if (!tenantId) {
                console.warn(
                  `[submit-product-selection] skipping Acquire fan-out for nbfc.id=${p.nbfc_id} — no tenant_id binding. Lead ${leadId} will not surface in this NBFC's Acquire queue until the nbfc row is repointed.`,
                );
                return null;
              }
              return {
                lead_id: leadId,
                nbfc_id: p.nbfc_id,
                tenant_id: tenantId,
                loan_product_id: p.loan_product_id,
                status: "pending" as const,
                service_config_snapshot: buildServiceSnapshot(
                  cfgByTenant.get(tenantId),
                  now,
                ),
              };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);

          if (assignmentRows.length > 0) {
            await tx
              .insert(nbfcLeadAssignments)
              .values(assignmentRows)
              .onConflictDoNothing({
                target: [
                  nbfcLeadAssignments.lead_id,
                  nbfcLeadAssignments.nbfc_id,
                ],
              });
          }
        }
      }

      return { productSelectionId };
    });

    notifyProductSelectionSubmitted({
      leadId,
      productSelectionId: result.productSelectionId,
      paymentMode: "finance",
      finalPrice: body.finalPrice ?? null,
    }).catch(() => {});

    // Admin + the picked NBFCs. Carries WHICH lenders and WHICH loan product the
    // dealer selected — the first thing anyone asks when a Step-4 submission
    // lands, and the reason this is more than a bare "Step 4 submitted".
    // Resolved after the transaction so the names come from committed rows.
    const picked = await db
      .select({
        name: nbfc.legal_name,
        short: nbfc.short_name,
        product: nbfcLoanProducts.product_name,
      })
      .from(nbfcLeadAssignments)
      .innerJoin(nbfc, eq(nbfc.id, nbfcLeadAssignments.nbfc_id))
      .leftJoin(
        nbfcLoanProducts,
        eq(nbfcLoanProducts.id, nbfcLeadAssignments.loan_product_id),
      )
      .where(eq(nbfcLeadAssignments.lead_id, leadId));

    await notifyProductSubmitted({
      leadId,
      productSelectionId: result.productSelectionId,
      paymentMode: "finance",
      finalPrice: body.finalPrice ?? null,
      nbfcNames: picked.map((p) => p.name || p.short || "").filter(Boolean),
      loanProduct: picked.map((p) => p.product).filter(Boolean).join(", ") || null,
      dealerName: await dealerDisplayName(user.dealer_id),
    });

    return NextResponse.json({
      success: true,
      data: {
        leadStatus: "pending_final_approval",
        productSelectionId: result.productSelectionId,
        // Nothing is locked here any more — inventory is reserved at Step 5
        // dispatch. Kept as an explicit null pair so callers that read the
        // shape see "no reservation" rather than a missing key.
        inventoryLocked: { battery: null, charger: null },
      },
    });
  } catch (error) {
    console.error("[Submit Product Selection] Error:", error);
    if (error instanceof InventoryLifecycleError) {
      return NextResponse.json(
        { success: false, error: { message: error.message } },
        { status: error.statusCode },
      );
    }
    const message = error instanceof Error ? error.message : "Failed to submit";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 400 },
    );
  }
}
