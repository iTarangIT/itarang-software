/**
 * E-298 — GET /api/dealer/loans/payment-pending
 *
 * Lead ids of the caller's disbursed loans still waiting for the dealer's
 * "payment received?" answer. Feeds the "Payment confirmation pending" badge on
 * the dealer leads list without widening the shared leads list query.
 */
import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, loanSanctions } from "@/lib/db/schema";
import { getAuthenticatedAppUser } from "@/lib/kyc/admin-workflow";
import { dealerVisibleLeads } from '@/lib/leads/dealerLeadScope';

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getAuthenticatedAppUser();
    if (!user) {
      return NextResponse.json({ success: false, error: { message: "Unauthorized" } }, { status: 401 });
    }
    if ((user.role ?? "").toLowerCase() !== "dealer" || !user.dealer_id) {
      return NextResponse.json({ success: true, data: { leadIds: [] } });
    }
    // 14 Oct: the house dealer also sees the files it pushed out (dealerLeadScope.ts).
    const visible = await dealerVisibleLeads(user.dealer_id);

    const rows = await db
      .selectDistinct({ lead_id: loanSanctions.lead_id })
      .from(loanSanctions)
      .innerJoin(leads, eq(leads.id, loanSanctions.lead_id))
      .where(
        and(
          visible,
          sql`${loanSanctions.dealer_payment_status} = 'pending'`,
        ),
      );

    return NextResponse.json({ success: true, data: { leadIds: rows.map((r) => r.lead_id) } });
  } catch (error) {
    // Likeliest cause: E-298 not applied on this host. The badge is optional.
    console.error("[dealer payment-pending] Error:", error);
    return NextResponse.json({ success: true, data: { leadIds: [] } });
  }
}
