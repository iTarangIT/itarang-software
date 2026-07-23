import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
  dealerAgreementSigners,
} from "@/lib/db/schema";
import { and, desc, inArray, isNotNull, ne, notInArray, or, sql } from "drizzle-orm";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { buildLocationHaystack } from "@/lib/dealer/location-haystack";
import { dealerTypeLabel, normalizeDealerType } from "@/lib/dealer/dealer-type";

// Excel export of the dealer verification queue.
//
// The column layout is FIXED (matches the "Agreement CRM Dump – Mandatory
// Fields" sheet). Rows mirror the on-screen queue's filtering + status mapping,
// so the export reflects exactly the dealers the admin currently sees, with all
// the filters they applied (date range, agreement, status, state/city/pincode,
// and the search box). Output is a styled .xlsx: bold coloured headers, frozen
// header row, auto-filter, zebra striping, and generous column widths.

type Col = { key: string; label: string; width: number; wrap?: boolean };

// Parse "YYYY-MM-DD" as local midnight so the day boundary aligns with what the
// admin picked in the UI (mirrors parseLocalDate in the page component).
function parseLocalDate(value: string | null): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Addresses are stored either as a JSON string (web onboarding writes
// `{ address: "..." }`) or as a structured jsonb object (NBFC-style
// `{ line1, city, state, pincode }`). Flatten either shape to a readable line.
function formatAddress(value: unknown): string {
  if (value === null || value === undefined) return "";
  let obj: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    } else {
      return trimmed;
    }
  }
  if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    if (typeof o.address === "string" && o.address.trim()) return o.address.trim();
    const parts = [
      o.line1, o.line2, o.street, o.area, o.city, o.district,
      o.state, o.pincode, o.pin, o.zip,
    ]
      .map((p) => (p == null ? "" : String(p).trim()))
      .filter(Boolean);
    return parts.join(", ");
  }
  return String(obj);
}

// Human-readable IST timestamp for the date columns.
function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

// Mirror the list route's status mapping so exported rows match the queue.
function mapStatus(onboarding: string | null, review: string | null): string {
  const o = (onboarding || "draft").toLowerCase();
  const r = (review || "").toLowerCase();
  if (["approved", "rejected", "correction_requested"].includes(o)) return o;
  if (r && r !== "draft") return r;
  return o;
}

// "Signed / Pending / N/A" for a signer row. If finance/agreement isn't
// applicable there is no signer, so the cell reads "N/A".
function signerCell(
  signer: { signer_status: string | null; signed_at: Date | null } | undefined,
  financeEnabled: boolean | null,
): string {
  if (!signer) return financeEnabled ? "Pending" : "N/A";
  if (signer.signed_at) return "Signed";
  const status = (signer.signer_status || "").trim();
  if (!status) return "Pending";
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
}

export async function GET(req: NextRequest) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;

  try {
    const sp = req.nextUrl.searchParams;
    const q = (sp.get("q") || "").trim().toLowerCase();
    const agreementStatus = (sp.get("agreementStatus") || "").trim();
    const statusParam = (sp.get("status") || "").trim();
    const companyTypeParam = (sp.get("companyType") || "").trim().toLowerCase();
    // E-202 dealer type. "unspecified" selects pre-E-202 rows with no value —
    // mirrors the queue's dropdown so a filtered export matches the screen.
    const dealerTypeParam = (sp.get("dealerType") || "").trim().toLowerCase();
    const sourceParam = (sp.get("source") || "").trim().toLowerCase();
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

    // Location filters match the flat columns OR the free-text address OR the
    // submissionSnapshot owner-address / GST places, because web/WhatsApp
    // onboarding leaves the flat city/state/pincode columns empty.
    const locationHaystack = (a: typeof applications[number]): string =>
      buildLocationHaystack({
        city: a.city,
        state: a.state,
        pincode: a.pincode,
        business_address: a.business_address,
        registered_address: a.registered_address,
        provider_raw_response: a.provider_raw_response,
      });

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
      if (companyTypeParam && (a.company_type || "").toLowerCase() !== companyTypeParam)
        return false;
      if (dealerTypeParam) {
        const t = normalizeDealerType(a.dealer_type);
        if (dealerTypeParam === "unspecified" ? t !== null : t !== dealerTypeParam)
          return false;
      }
      if (sourceParam && (a.source || "web").toLowerCase() !== sourceParam) return false;
      const loc = stateParam || cityParam || pincodeParam ? locationHaystack(a) : "";
      if (stateParam && !loc.includes(stateParam)) return false;
      if (cityParam && !loc.includes(cityParam)) return false;
      if (pincodeParam && !loc.includes(pincodeParam.toLowerCase())) return false;
      if (q) {
        const hay = [
          a.owner_name, a.company_name, a.gst_number,
          status, a.company_type, a.sales_manager_name, a.owner_email,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const ids = filtered.map((a) => a.id);

    // Distinct document-type counts (excludes superseded / pending_correction),
    // mirroring the on-screen "N uploaded" badge.
    const docCountMap = new Map<string, number>();
    // Latest signer per role, per application, for the signed/pending columns.
    const dealerSignerMap = new Map<string, { signer_status: string | null; signed_at: Date | null }>();
    const itarangSignerMap = new Map<string, { signer_status: string | null; signed_at: Date | null }>();

    if (ids.length > 0) {
      const docCounts = await db
        .select({
          applicationId: dealerOnboardingDocuments.application_id,
          count: sql<number>`cast(count(distinct ${dealerOnboardingDocuments.document_type}) as integer)`,
        })
        .from(dealerOnboardingDocuments)
        .where(
          and(
            inArray(dealerOnboardingDocuments.application_id, ids),
            notInArray(dealerOnboardingDocuments.doc_status, ["superseded", "pending_correction"]),
          ),
        )
        .groupBy(dealerOnboardingDocuments.application_id);
      for (const row of docCounts) docCountMap.set(row.applicationId, row.count);

      const signers = await db
        .select({
          applicationId: dealerAgreementSigners.application_id,
          signerRole: dealerAgreementSigners.signer_role,
          signerStatus: dealerAgreementSigners.signer_status,
          signedAt: dealerAgreementSigners.signed_at,
        })
        .from(dealerAgreementSigners)
        .where(inArray(dealerAgreementSigners.application_id, ids));
      for (const s of signers) {
        const role = (s.signerRole || "").toLowerCase();
        const cell = { signer_status: s.signerStatus, signed_at: s.signedAt };
        if (role === "dealer") {
          // A signed row wins over a pending one for the same application.
          const prev = dealerSignerMap.get(s.applicationId);
          if (!prev || (!prev.signed_at && s.signedAt)) dealerSignerMap.set(s.applicationId, cell);
        } else if (role.startsWith("itarang")) {
          const prev = itarangSignerMap.get(s.applicationId);
          if (!prev || (!prev.signed_at && s.signedAt)) itarangSignerMap.set(s.applicationId, cell);
        }
      }
    }

    // ── Fixed column layout (Agreement CRM Dump – Mandatory Fields) ──
    const columns: Col[] = [
      { key: "dealerCode", label: "Dealer Code", width: 16 },
      { key: "companyName", label: "Company Name", width: 30, wrap: true },
      { key: "companyType", label: "Company Type", width: 18 },
      { key: "gstNumber", label: "GST Number", width: 20 },
      { key: "panNumber", label: "PAN Number", width: 16 },
      { key: "ownerName", label: "Owner Name", width: 24 },
      { key: "ownerEmail", label: "Owner Email", width: 30 },
      { key: "ownerPhone", label: "Owner Phone", width: 16 },
      { key: "dealerSigned", label: "Dealer signed", width: 14 },
      { key: "salesManagerName", label: "Sales Manager Name", width: 24 },
      { key: "salesManagerEmail", label: "Sales Manager Email", width: 30 },
      { key: "salesManagerMobile", label: "Sales Manager Mobile", width: 20 },
      { key: "itarangSigned", label: "iTarang business ower sign", width: 22 },
      { key: "businessAddress", label: "Business Address", width: 42, wrap: true },
      { key: "registeredAddress", label: "Registered Address", width: 42, wrap: true },
      { key: "bankName", label: "Bank Name", width: 24 },
      { key: "accountNumber", label: "Account Number", width: 22 },
      { key: "beneficiaryName", label: "Beneficiary Name", width: 24 },
      { key: "ifscCode", label: "IFSC Code", width: 16 },
      { key: "onboardingStatus", label: "Onboarding Status", width: 22 },
      { key: "agreementExpiringDate", label: "Agreement expireing date", width: 24 },
      { key: "dealerAccountStatus", label: "Dealer Account Status", width: 20 },
      { key: "financeEnabled", label: "Finance Enabled", width: 14 },
      { key: "documentsUploaded", label: "Documents Uploaded", width: 16 },
      { key: "agreementStatus", label: "Agreement Status", width: 20 },
      { key: "stampStatus", label: "Stamp Status", width: 16 },
      { key: "completionStatus", label: "Completion Status", width: 18 },
      { key: "createdAt", label: "Created At", width: 22 },
      { key: "submittedAt", label: "Submitted At", width: 22 },
      { key: "approvedAt", label: "Approved At", width: 22 },
      { key: "rejectedAt", label: "Rejected At", width: 22 },
      { key: "rejectionRemarks", label: "Rejection Remarks", width: 32, wrap: true },
      { key: "correctionRemarks", label: "Correction Remarks", width: 32, wrap: true },
      { key: "regenerateAgreement", label: "Re-genrate Agreement / CRM/ Dgio", width: 30, wrap: true },
      // E-202. Appended at the END on purpose: the columns above mirror the
      // "Agreement CRM Dump – Mandatory Fields" sheet, so inserting beside
      // Company Type (where it belongs logically) would shift every later
      // column letter and break anything downstream keyed on position.
      { key: "dealerType", label: "Dealer Type", width: 24 },
    ];

    const records = filtered.map((a) => ({
      dealerCode: a.dealer_code || "",
      companyName: a.company_name || "",
      companyType: a.company_type ? a.company_type.replaceAll("_", " ") : "",
      gstNumber: a.gst_number || "",
      panNumber: a.pan_number || "",
      ownerName: a.owner_name || "",
      ownerEmail: a.owner_email || "",
      ownerPhone: a.owner_phone || "",
      dealerSigned: signerCell(dealerSignerMap.get(a.id), a.finance_enabled),
      salesManagerName: a.sales_manager_name || "",
      salesManagerEmail: a.sales_manager_email || "",
      salesManagerMobile: a.sales_manager_mobile || "",
      itarangSigned: signerCell(itarangSignerMap.get(a.id), a.finance_enabled),
      businessAddress: formatAddress(a.business_address),
      registeredAddress: formatAddress(a.registered_address),
      bankName: a.bank_name || "",
      accountNumber: a.account_number || "",
      beneficiaryName: a.beneficiary_name || "",
      ifscCode: a.ifsc_code || "",
      onboardingStatus: mapStatus(a.onboarding_status, a.review_status),
      agreementExpiringDate: formatDate(a.agreement_expired_at),
      dealerAccountStatus: a.dealer_account_status || "",
      financeEnabled: a.finance_enabled ? "Yes" : "No",
      documentsUploaded: docCountMap.get(a.id) ?? 0,
      agreementStatus: !a.finance_enabled
        ? "N/A"
        : (a.agreement_status?.trim() || "not_generated"),
      stampStatus: a.stamp_status || "",
      completionStatus: a.completion_status || "",
      createdAt: formatDate(a.created_at),
      submittedAt: formatDate(a.submitted_at),
      approvedAt: formatDate(a.approved_at),
      rejectedAt: formatDate(a.rejected_at),
      rejectionRemarks: a.rejection_remarks || a.rejection_reason || "",
      correctionRemarks: a.correction_remarks || "",
      // No data source — manual fill-in column kept for the team's workflow.
      regenerateAgreement: "",
      dealerType: dealerTypeLabel(a.dealer_type, ""),
    }));

    // ── Build the styled workbook ──────────────────────────────────────────
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "iTarang";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Dealer Verifications", {
      views: [{ state: "frozen", ySplit: 1 }],
    });

    sheet.columns = columns.map((c) => ({ header: c.label, key: c.key, width: c.width }));

    // Header row — bold white text on an iTarang-blue band.
    const headerRow = sheet.getRow(1);
    headerRow.height = 30;
    headerRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D4ED8" } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = {
        top: { style: "thin", color: { argb: "FF1E3A8A" } },
        bottom: { style: "thin", color: { argb: "FF1E3A8A" } },
        left: { style: "thin", color: { argb: "FF1E3A8A" } },
        right: { style: "thin", color: { argb: "FF1E3A8A" } },
      };
    });

    records.forEach((rec, i) => {
      const row = sheet.addRow(rec);
      row.height = 20;
      const zebra = i % 2 === 1;
      row.eachCell((cell, colNumber) => {
        const col = columns[colNumber - 1];
        cell.alignment = {
          vertical: "middle",
          horizontal: "left",
          wrapText: !!col?.wrap,
        };
        if (zebra) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
        }
        cell.border = { bottom: { style: "hair", color: { argb: "FFE2E8F0" } } };
      });
    });

    // Auto-filter dropdowns on every column header.
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length },
    };

    const buffer = await workbook.xlsx.writeBuffer();
    const today = new Date().toISOString().slice(0, 10);
    const suffix = agreementStatus === "pending" ? "agreement-pending" : "queue";
    const filename = `dealer-verifications-${suffix}-${today}.xlsx`;

    return new Response(Buffer.from(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": buffer.byteLength.toString(),
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
