import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { desc, isNotNull, ne, or } from "drizzle-orm";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";

// CSV export of the dealer verification queue.
//
// Columns ADAPT to the active filters: a core set is always present; the
// agreement-status filter adds agreement columns; a location/pincode filter
// adds city/state/pincode. Rows mirror the on-screen queue's filtering + status
// mapping, so the export matches what the admin sees.

type Col = { key: string; label: string };

// Parse "YYYY-MM-DD" as local midnight so the day boundary aligns with what the
// admin picked in the UI (mirrors parseLocalDate in the page component).
function parseLocalDate(value: string | null): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let str: string;
  if (value instanceof Date) str = value.toISOString();
  else if (typeof value === "boolean") str = value ? "Yes" : "No";
  else str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Mirror the list route's status mapping so exported rows match the queue.
function mapStatus(onboarding: string | null, review: string | null): string {
  const o = (onboarding || "draft").toLowerCase();
  const r = (review || "").toLowerCase();
  if (["approved", "rejected", "correction_requested"].includes(o)) return o;
  if (r && r !== "draft") return r;
  return o;
}

export async function GET(req: NextRequest) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;

  try {
    const sp = req.nextUrl.searchParams;
    const q = (sp.get("q") || "").trim().toLowerCase();
    const agreementStatus = (sp.get("agreementStatus") || "").trim();
    const statusParam = (sp.get("status") || "").trim();
    const stateParam = (sp.get("state") || "").trim().toLowerCase();
    const cityParam = (sp.get("city") || "").trim().toLowerCase();
    const pincodeParam = (sp.get("pincode") || "").trim();

    const fromD = parseLocalDate(sp.get("dateFrom"));
    const toD = parseLocalDate(sp.get("dateTo"));
    if (fromD) fromD.setHours(0, 0, 0, 0);
    if (toD) toD.setHours(23, 59, 59, 999);

    // Same base visibility as the list route (hide pure drafts).
    const applications = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(
        or(
          ne(dealerOnboardingApplications.onboarding_status, "draft"),
          isNotNull(dealerOnboardingApplications.submitted_at),
        ),
      )
      .orderBy(
        desc(dealerOnboardingApplications.updated_at),
        desc(dealerOnboardingApplications.created_at),
      );

    const filtered = applications.filter((a) => {
      const status = mapStatus(a.onboarding_status, a.review_status);
      const ag = (a.agreement_status || "").toLowerCase();

      if (fromD || toD) {
        if (!a.submitted_at) return false;
        const s = new Date(a.submitted_at);
        if (fromD && s < fromD) return false;
        if (toD && s > toD) return false;
      }
      if (agreementStatus) {
        if (agreementStatus === "pending") {
          if (!(a.finance_enabled && ["sent_for_signature", "partially_signed"].includes(ag)))
            return false;
        } else if (ag !== agreementStatus) {
          return false;
        }
      }
      if (statusParam && status !== statusParam) return false;
      if (stateParam && !(a.state || "").toLowerCase().includes(stateParam)) return false;
      if (cityParam && !(a.city || "").toLowerCase().includes(cityParam)) return false;
      if (pincodeParam && !(a.pincode || "").includes(pincodeParam)) return false;
      if (q) {
        const hay = [
          a.owner_name, a.company_name, a.gst_number,
          status, a.company_type, a.sales_manager_name, a.owner_email,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    // ── Adaptive columns ──────────────────────────────────────────────────────
    const columns: Col[] = [
      { key: "dealerName", label: "Dealer Name" },
      { key: "companyName", label: "Company Name" },
      { key: "companyType", label: "Company Type" },
      { key: "gstNumber", label: "GST Number" },
      { key: "salesManager", label: "Sales Manager" },
      { key: "source", label: "Source" },
      { key: "status", label: "Status" },
      { key: "submittedAt", label: "Submitted At" },
    ];
    if (agreementStatus) {
      columns.push(
        { key: "financeEnabled", label: "Finance Enabled" },
        { key: "agreementStatus", label: "Agreement Status" },
        { key: "stampStatus", label: "Stamp Status" },
        { key: "signedAt", label: "Signed At" },
        { key: "approvedAt", label: "Approved At" },
      );
    }
    if (stateParam || cityParam || pincodeParam) {
      columns.push(
        { key: "city", label: "City" },
        { key: "state", label: "State" },
        { key: "pincode", label: "Pincode" },
      );
    }

    const records = filtered.map((a) => ({
      dealerName: a.owner_name || a.company_name || "—",
      companyName: a.company_name || "—",
      companyType: a.company_type ? a.company_type.replaceAll("_", " ") : "",
      gstNumber: a.gst_number || "",
      salesManager: a.sales_manager_name || "",
      source: (a.source || "web").toLowerCase(),
      status: mapStatus(a.onboarding_status, a.review_status),
      submittedAt: a.submitted_at ? new Date(a.submitted_at).toISOString() : "",
      financeEnabled: a.finance_enabled ? "Yes" : "No",
      agreementStatus: !a.finance_enabled
        ? "N/A"
        : (a.agreement_status?.trim() || "not_generated"),
      stampStatus: a.stamp_status || "",
      signedAt: a.signed_at ? new Date(a.signed_at).toISOString() : "",
      approvedAt: a.approved_at ? new Date(a.approved_at).toISOString() : "",
      city: a.city || "",
      state: a.state || "",
      pincode: a.pincode || "",
    }));

    const csvBody = [
      columns.map((c) => csvEscape(c.label)).join(","),
      ...records.map((rec) =>
        columns.map((c) => csvEscape((rec as Record<string, unknown>)[c.key])).join(","),
      ),
    ].join("\n");

    // UTF-8 BOM so Excel detects encoding for Indian names / GST.
    const csv = "﻿" + csvBody;

    const today = new Date().toISOString().slice(0, 10);
    const suffix = agreementStatus === "pending" ? "agreement-pending" : "queue";
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="dealer-verifications-${suffix}-${today}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("ADMIN DEALER VERIFICATIONS EXPORT ERROR:", error);
    return NextResponse.json(
      { success: false, message: "Failed to export dealer verifications" },
      { status: 500 },
    );
  }
}
