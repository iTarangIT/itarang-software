import { NextRequest, NextResponse } from "next/server";
import { desc, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, loanSanctions, productSelections } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";

// BRD V2 Part E — admin Step 4 product-review queue.
// Returns the latest product_selection per lead, joined with the latest
// loan_sanction, plus KPI counts. Drives /admin/product-review.

type StatusFilter = "pending" | "sanctioned" | "rejected" | "all";

const ALLOWED_STATUS: ReadonlySet<StatusFilter> = new Set([
  "pending",
  "sanctioned",
  "rejected",
  "all",
]);

function parseStatus(value: string | null): StatusFilter {
  if (value && ALLOWED_STATUS.has(value as StatusFilter)) {
    return value as StatusFilter;
  }
  return "pending";
}

export async function GET(req: NextRequest) {
  try {
    const admin = await requireAdminAppUser();
    if (!admin) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(req.url);
    const statusFilter = parseStatus(searchParams.get("status"));
    const paymentMode = searchParams.get("payment_mode")?.trim().toLowerCase() || "";
    const search = searchParams.get("q")?.trim().toLowerCase() || "";

    // Latest product selection per lead. There's no per-lead unique constraint,
    // so dedupe in JS by ordering desc and keeping the first occurrence.
    const allSelections = await db
      .select()
      .from(productSelections)
      .orderBy(desc(productSelections.created_at))
      .limit(1000);

    const latestByLead = new Map<string, typeof allSelections[number]>();
    for (const row of allSelections) {
      if (!latestByLead.has(row.lead_id)) latestByLead.set(row.lead_id, row);
    }
    const leadIds = [...latestByLead.keys()];

    if (leadIds.length === 0) {
      return NextResponse.json({
        success: true,
        data: {
          rows: [],
          kpis: { total: 0, pending: 0, sanctioned: 0, rejected: 0 },
        },
      });
    }

    const [leadRows, sanctionRows] = await Promise.all([
      db
        .select({
          id: leads.id,
          owner_name: leads.owner_name,
          business_name: leads.business_name,
          kyc_status: leads.kyc_status,
          payment_method: leads.payment_method,
        })
        .from(leads)
        .where(inArray(leads.id, leadIds)),
      db
        .select()
        .from(loanSanctions)
        .where(inArray(loanSanctions.lead_id, leadIds))
        .orderBy(desc(loanSanctions.created_at)),
    ]);

    const leadById = new Map(leadRows.map((l) => [l.id, l]));
    const latestSanctionByLead = new Map<string, typeof sanctionRows[number]>();
    for (const row of sanctionRows) {
      if (!latestSanctionByLead.has(row.lead_id)) latestSanctionByLead.set(row.lead_id, row);
    }

    // Build the unified row set first (pre-filter), then derive KPIs from it
    // so counts always reflect the same dataset the page can browse.
    const allRows = leadIds
      .map((leadId) => {
        const sel = latestByLead.get(leadId)!;
        const lead = leadById.get(leadId);
        const sanction = latestSanctionByLead.get(leadId) ?? null;

        const loanStatus = sanction?.status ?? null; // 'sanctioned' | 'rejected' | null
        let derivedStatus: "pending" | "sanctioned" | "rejected";
        if (loanStatus === "sanctioned") derivedStatus = "sanctioned";
        else if (loanStatus === "rejected") derivedStatus = "rejected";
        else derivedStatus = "pending";

        return {
          lead_id: leadId,
          owner_name: lead?.owner_name?.trim() || "Unknown",
          dealer_name: lead?.business_name?.trim() || "—",
          kyc_status: lead?.kyc_status || "pending",
          payment_mode: sel.payment_mode || lead?.payment_method || "—",
          admin_decision: sel.admin_decision || "pending",
          status: derivedStatus,
          battery_serial: sel.battery_serial,
          charger_serial: sel.charger_serial,
          final_price: sel.final_price,
          submitted_at: sel.submitted_at,
          loan_amount: sanction?.loan_amount ?? null,
          rejection_reason: sanction?.rejection_reason ?? null,
        };
      })
      .filter((r) => r); // lead row may be missing if lead was deleted; keep selection visible regardless

    const kpis = {
      total: allRows.length,
      pending: allRows.filter((r) => r.status === "pending").length,
      sanctioned: allRows.filter((r) => r.status === "sanctioned").length,
      rejected: allRows.filter((r) => r.status === "rejected").length,
    };

    const filtered = allRows
      .filter((r) => (statusFilter === "all" ? true : r.status === statusFilter))
      .filter((r) => (paymentMode ? r.payment_mode === paymentMode : true))
      .filter((r) => {
        if (!search) return true;
        return (
          r.owner_name.toLowerCase().includes(search) ||
          r.dealer_name.toLowerCase().includes(search) ||
          r.lead_id.toLowerCase().includes(search)
        );
      })
      .sort((a, b) => {
        const aTime = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
        const bTime = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
        return bTime - aTime;
      });

    return NextResponse.json({
      success: true,
      data: { rows: filtered, kpis },
    });
  } catch (error) {
    console.error("[Admin Product Reviews] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to load product reviews";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
