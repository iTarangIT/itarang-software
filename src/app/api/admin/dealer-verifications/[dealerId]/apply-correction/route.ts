import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/index";
import {
  dealerCorrectionItems,
  dealerCorrectionRounds,
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
} from "@/lib/db/schema";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import {
  CORRECTION_FIELDS,
  type CorrectionFieldKey,
} from "@/lib/onboarding/correction-catalog";

// POST /api/admin/dealer-verifications/[dealerId]/apply-correction
//
// Merges a submitted correction round into the application:
//   • field newValues → matching columns on dealerOnboardingApplications
//   • old docs → docStatus="superseded"; new docs → docStatus="uploaded"
//   • round.status → "applied"
//   • application.onboardingStatus → "submitted" (this unlocks the existing
//     Approve & Activate button — see approve/route.ts gate at line ~90)
//
// Approve remains a separate explicit click — admin sees the merged state
// before taking the irreversible approve action.

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

// Catalog keys are guaranteed to exist as property names on the
// dealerOnboardingApplications schema; this constant is just a typed
// allowlist so we never write a column the catalog hasn't blessed.
const ALLOWED_FIELD_KEYS = new Set<CorrectionFieldKey>(
  CORRECTION_FIELDS.map((f) => f.key),
);

export async function POST(req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;

  try {
    const { dealerId } = await context.params;
    const body = await req.json().catch(() => ({}));
    const roundId = typeof body?.roundId === "string" ? body.roundId.trim() : "";

    if (!roundId) {
      return NextResponse.json(
        { success: false, message: "roundId is required" },
        { status: 400 },
      );
    }

    const [round] = await db
      .select()
      .from(dealerCorrectionRounds)
      .where(eq(dealerCorrectionRounds.id, roundId))
      .limit(1);

    if (!round) {
      return NextResponse.json(
        { success: false, message: "Correction round not found" },
        { status: 404 },
      );
    }

    if (round.application_id !== dealerId) {
      return NextResponse.json(
        { success: false, message: "Round does not belong to this dealer" },
        { status: 400 },
      );
    }

    if (round.status !== "submitted") {
      return NextResponse.json(
        {
          success: false,
          message:
            "Only a submitted correction round can be applied. Current status: " +
            round.status,
        },
        { status: 409 },
      );
    }

    const items = await db
      .select()
      .from(dealerCorrectionItems)
      .where(eq(dealerCorrectionItems.round_id, round.id));

    // ── Merge field updates ─────────────────────────────────────────────────
    const fieldUpdates: Partial<Record<CorrectionFieldKey, string>> = {};
    for (const item of items) {
      if (item.kind !== "field") continue;
      if (!ALLOWED_FIELD_KEYS.has(item.key as CorrectionFieldKey)) continue;
      // Skip items the dealer didn't actually fill in (defense — shouldn't
      // happen because the POST submit handler enforces all-or-nothing).
      if (item.new_value === null || item.new_value === undefined) continue;
      fieldUpdates[item.key as CorrectionFieldKey] = item.new_value;
    }

    // ── Promote new docs / supersede old docs ───────────────────────────────
    const newDocIds = items
      .map((it) => (it.kind === "document" ? it.new_document_id : null))
      .filter((v): v is string => !!v);
    const oldDocIds = items
      .map((it) =>
        it.kind === "document" && it.new_document_id ? it.previous_document_id : null,
      )
      .filter((v): v is string => !!v);

    if (newDocIds.length > 0) {
      await db
        .update(dealerOnboardingDocuments)
        .set({
          doc_status: "uploaded",
          verification_status: "pending",
          updated_at: new Date(),
        })
        .where(inArray(dealerOnboardingDocuments.id, newDocIds));
    }

    if (oldDocIds.length > 0) {
      await db
        .update(dealerOnboardingDocuments)
        .set({
          doc_status: "superseded",
          updated_at: new Date(),
        })
        .where(
          and(
            inArray(dealerOnboardingDocuments.id, oldDocIds),
            eq(dealerOnboardingDocuments.application_id, dealerId),
          ),
        );
    }

    // ── Update the application row ──────────────────────────────────────────
    //
    // Don't unconditionally downgrade reviewStatus/completionStatus: a
    // finance-enabled dealer who already has a completed agreement must keep
    // reviewStatus = "agreement_completed" or the existing Approve gate
    // (approve/route.ts) will reject them after a correction merge. The
    // alternative — re-sending them through agreement signing because they
    // fixed a typo on the bank field — would be cruel.
    const [currentRow] = await db
      .select({
        financeEnabled: dealerOnboardingApplications.finance_enabled,
        agreementStatus: dealerOnboardingApplications.agreement_status,
      })
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    const agreementAlreadyComplete =
      !!currentRow?.financeEnabled &&
      (currentRow?.agreementStatus || "").toLowerCase() === "completed";

    await db
      .update(dealerOnboardingApplications)
      .set({
        ...fieldUpdates,
        onboarding_status: "submitted",
        review_status: agreementAlreadyComplete
          ? "agreement_completed"
          : "under_review",
        completion_status: agreementAlreadyComplete ? "completed" : "pending",
        dealer_account_status: "inactive",
        correction_remarks: null,
        updated_at: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    // ── Close out the round ─────────────────────────────────────────────────
    await db
      .update(dealerCorrectionRounds)
      .set({
        status: "applied",
        applied_at: new Date(),
        applied_by: auth.user.id,
        updated_at: new Date(),
      })
      .where(eq(dealerCorrectionRounds.id, round.id));

    return NextResponse.json({
      success: true,
      message: "Correction applied. You can now approve the dealer.",
      fieldsUpdated: Object.keys(fieldUpdates),
      documentsPromoted: newDocIds.length,
      documentsSuperseded: oldDocIds.length,
    });
  } catch (error: any) {
    console.error("APPLY CORRECTION ERROR:", error);
    return NextResponse.json(
      { success: false, message: error?.message || "Error" },
      { status: 500 },
    );
  }
}
