/**
 * POST /api/lead/[id]/select-winner
 *
 * BRD Addendum V0.2 §6.1 / §6.2 — the customer (dealer-mediated) compares the
 * firm offers submitted by the picked NBFCs and selects the WINNER. The chosen
 * assignment becomes 'selected'; every other assignment for the lead becomes
 * 'not_selected' and its NBFC is notified (§6.2 "loser auto Not Selected; owner
 * notified"). The lead advances to 'awaiting_enach' so the winner-only E-NACH
 * track (enach.getWinningAssignment, status='selected') unlocks.
 *
 * The 1-NBFC case is the same path: accepting the single offer = selecting it.
 *
 * Role: dealer (customer-present). Body: { nbfcId: number }.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne, notInArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, nbfc, nbfcLeadAssignments } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { sendNotSelectedEmail } from "@/lib/email/sendManualHandoffEmail";
import { notifyWinnerSelected } from "@/lib/notifications/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;

    let body: { nbfcId?: number | string } = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, error: { message: "Invalid JSON" } }, { status: 400 });
    }
    const chosenNbfcId = Number(body.nbfcId);
    if (!Number.isFinite(chosenNbfcId)) {
      return NextResponse.json({ success: false, error: { message: "nbfcId required" } }, { status: 400 });
    }

    const [lead] = await db
      .select({ id: leads.id, dealer_id: leads.dealer_id, kyc_status: leads.kyc_status })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) {
      return NextResponse.json({ success: false, error: { message: "Lead not found" } }, { status: 404 });
    }
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json({ success: false, error: { message: "Access denied" } }, { status: 403 });
    }

    const assignments = await db
      .select({
        id: nbfcLeadAssignments.id,
        nbfc_id: nbfcLeadAssignments.nbfc_id,
        status: nbfcLeadAssignments.status,
      })
      .from(nbfcLeadAssignments)
      .where(eq(nbfcLeadAssignments.lead_id, leadId));

    const chosen = assignments.find((a) => a.nbfc_id === chosenNbfcId);
    if (!chosen) {
      return NextResponse.json(
        { success: false, error: { message: "Chosen NBFC is not among this lead's routed NBFCs" } },
        { status: 400 },
      );
    }
    if (chosen.status !== "offer_submitted") {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `That NBFC has not submitted a firm offer yet (status '${chosen.status}'). A winner can only be picked from submitted offers.`,
          },
        },
        { status: 400 },
      );
    }

    const now = new Date();
    const loserNbfcIds = assignments
      .filter(
        (a) =>
          a.nbfc_id !== chosenNbfcId &&
          // Already told they were out — see the notInArray in the sweep below.
          a.status !== "withdrawn" &&
          a.status !== "declined",
      )
      .map((a) => a.nbfc_id);

    await db.transaction(async (tx) => {
      await tx
        .update(nbfcLeadAssignments)
        .set({ status: "selected", decided_at: now, decision_reason: "customer_selected", updated_at: now })
        .where(eq(nbfcLeadAssignments.id, chosen.id));

      await tx
        .update(nbfcLeadAssignments)
        .set({
          status: "not_selected",
          decided_at: now,
          decision_reason: "customer_picked_other",
          updated_at: now,
        })
        .where(
          and(
            eq(nbfcLeadAssignments.lead_id, leadId),
            ne(nbfcLeadAssignments.nbfc_id, chosenNbfcId),
            // E-245 — a lender the dealer already CLOSED (or that declined) did
            // not lose to this winner, and overwriting it with 'not_selected'
            // would erase the only record of why that conversation ended.
            notInArray(nbfcLeadAssignments.status, ["withdrawn", "declined"]),
          ),
        );

      await tx
        .update(leads)
        .set({ kyc_status: "awaiting_enach", updated_at: now })
        .where(eq(leads.id, leadId));
    });

    // Notify each losing NBFC (best-effort — must not fail the selection).
    if (loserNbfcIds.length > 0) {
      try {
        const [leadName] = await db
          .select({ full_name: leads.full_name, owner_name: leads.owner_name })
          .from(leads)
          .where(eq(leads.id, leadId))
          .limit(1);
        const customerName = leadName?.full_name ?? leadName?.owner_name ?? "the customer";
        for (const loserId of loserNbfcIds) {
          const [row] = await db
            .select({ short_name: nbfc.short_name, email: nbfc.primary_contact_email })
            .from(nbfc)
            .where(eq(nbfc.id, loserId))
            .limit(1);
          if (row?.email) {
            await sendNotSelectedEmail({
              toEmails: [row.email],
              leadId,
              nbfcName: row.short_name ?? "NBFC",
              customerName,
            });
          }
        }
      } catch (err) {
        console.error("[select-winner] loser notification failed:", err);
      }
    }

    // In-app: the winner is told to proceed, every loser is told the lead is
    // gone, and the admin sees the decision. The loser email above stays — it
    // reaches NBFC contacts who have no portal login.
    const [winnerNbfc] = await db
      .select({ tenant_id: nbfc.tenant_id, legal_name: nbfc.legal_name, short_name: nbfc.short_name })
      .from(nbfc)
      .where(eq(nbfc.id, chosenNbfcId))
      .limit(1);
    if (winnerNbfc?.tenant_id) {
      await notifyWinnerSelected({
        leadId,
        winnerTenantId: winnerNbfc.tenant_id,
        winnerName: winnerNbfc.legal_name || winnerNbfc.short_name || "the lender",
      });
    }

    return NextResponse.json({
      success: true,
      data: { leadId, winnerNbfcId: chosenNbfcId, kycStatus: "awaiting_enach" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to select winner";
    console.error("[select-winner] error:", error);
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
