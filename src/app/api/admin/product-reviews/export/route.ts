import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, loanSanctions, productSelections, users } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { tryToPaymentMode } from "@/lib/sales/payment-mode";

// CSV export for /admin/product-review. Mirrors the data-shape of
// /api/admin/product-reviews and applies the same status / payment_mode / q
// filters so the downloaded file matches what the admin sees in the table.
// Format is CSV with a UTF-8 BOM so Excel auto-detects encoding and renders ₹,
// Indian names, etc. correctly.

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
  return "all";
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let str: string;
  if (value instanceof Date) {
    str = value.toISOString();
  } else if (typeof value === "boolean") {
    str = value ? "Yes" : "No";
  } else {
    str = String(value);
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
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
    const rawPayment = searchParams.get("payment_mode")?.trim().toLowerCase() || "";
    const paymentMode: "cash" | "finance" | "" =
      rawPayment === "cash" || rawPayment === "finance" ? rawPayment : "";
    const search = searchParams.get("q")?.trim().toLowerCase() || "";

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
      return new NextResponse(csvHeaderRow() + "\n", csvHeaders());
    }

    const [leadRows, sanctionRows] = await Promise.all([
      db
        .select({
          id: leads.id,
          owner_name: leads.owner_name,
          business_name: leads.business_name,
          kyc_status: leads.kyc_status,
          payment_method: leads.payment_method,
          dealer_id: leads.dealer_id,
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

    const dealerIds = [
      ...new Set(
        leadRows
          .map((l) => l.dealer_id)
          .filter((id): id is string => !!id),
      ),
    ];
    const dealerRows = dealerIds.length
      ? await db
          .select({
            dealer_id: users.dealer_id,
            name: users.name,
            phone: users.phone,
            is_active: users.is_active,
          })
          .from(users)
          .where(
            and(
              inArray(users.dealer_id, dealerIds),
              eq(users.role, "dealer"),
            ),
          )
      : [];
    const dealerByDealerId = new Map<string, { name: string | null; phone: string | null }>();
    for (const d of dealerRows) {
      if (!d.dealer_id) continue;
      const existing = dealerByDealerId.get(d.dealer_id);
      if (!existing || d.is_active) {
        dealerByDealerId.set(d.dealer_id, { name: d.name, phone: d.phone });
      }
    }

    const rows = leadIds.map((leadId) => {
      const sel = latestByLead.get(leadId)!;
      const lead = leadById.get(leadId);
      const sanction = latestSanctionByLead.get(leadId) ?? null;

      const adminDecision = String(sel.admin_decision ?? "").toLowerCase();
      const loanStatus = String(sanction?.status ?? "").toLowerCase();
      let status: "pending" | "sanctioned" | "rejected";
      if (adminDecision === "sanctioned" || loanStatus === "sanctioned") {
        status = "sanctioned";
      } else if (adminDecision === "rejected" || loanStatus === "rejected") {
        status = "rejected";
      } else {
        status = "pending";
      }

      const dealerInfo = lead?.dealer_id
        ? dealerByDealerId.get(lead.dealer_id) ?? null
        : null;

      return {
        lead_id: leadId,
        owner_name: lead?.owner_name?.trim() || "Unknown",
        dealer_name:
          dealerInfo?.name?.trim() ||
          lead?.business_name?.trim() ||
          "—",
        dealer_phone: dealerInfo?.phone ?? null,
        kyc_status: lead?.kyc_status || "pending",
        payment_mode: sel.payment_mode || lead?.payment_method || "",
        admin_decision: sel.admin_decision || "pending",
        status,
        battery_serial: sel.battery_serial,
        charger_serial: sel.charger_serial,
        final_price: sel.final_price,
        submitted_at: sel.submitted_at,
        loan_amount: sanction?.loan_amount ?? null,
        rejection_reason: sanction?.rejection_reason ?? null,
      };
    });

    const filtered = rows
      .filter((r) => (statusFilter === "all" ? true : r.status === statusFilter))
      .filter((r) => {
        if (!paymentMode) return true;
        return tryToPaymentMode(r.payment_mode) === paymentMode;
      })
      .filter((r) => {
        if (!search) return true;
        return (
          r.owner_name.toLowerCase().includes(search) ||
          r.dealer_name.toLowerCase().includes(search) ||
          (r.dealer_phone?.toLowerCase() ?? "").includes(search) ||
          r.lead_id.toLowerCase().includes(search)
        );
      })
      .sort((a, b) => {
        const aTime = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
        const bTime = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
        return bTime - aTime;
      });

    const csvBody = [
      csvHeaderRow(),
      ...filtered.map((r) =>
        [
          r.lead_id,
          r.owner_name,
          r.dealer_name,
          r.dealer_phone ?? "",
          r.kyc_status,
          r.payment_mode,
          r.admin_decision,
          r.status,
          r.battery_serial ?? "",
          r.charger_serial ?? "",
          r.final_price ?? "",
          r.loan_amount ?? "",
          r.submitted_at ? new Date(r.submitted_at).toISOString() : "",
          r.rejection_reason ?? "",
        ]
          .map(csvEscape)
          .join(","),
      ),
    ].join("\n");

    return new NextResponse("﻿" + csvBody, csvHeaders());
  } catch (error) {
    console.error("[Admin Product Reviews Export] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to export product reviews";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}

function csvHeaderRow(): string {
  return [
    "Lead ID",
    "Owner Name",
    "Dealer Name",
    "Dealer Phone",
    "KYC Status",
    "Payment Mode",
    "Admin Decision",
    "Status",
    "Battery Serial",
    "Charger Serial",
    "Final Price",
    "Loan Amount",
    "Submitted At",
    "Rejection Reason",
  ]
    .map(csvEscape)
    .join(",");
}

function csvHeaders(): ResponseInit {
  const today = new Date().toISOString().slice(0, 10);
  return {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="product-reviews-${today}.csv"`,
      "Cache-Control": "no-store",
    },
  };
}
