"use client";

/**
 * The type-neutral top of a dealer's dashboard: who they are, and where their
 * onboarding stands.
 *
 * Extracted from DealerDashboard when E-202/E-225 introduced a second dashboard
 * variant (ScrapDealerDashboard). These three blocks are identical for every
 * dealer type — a scrap dealer still has a dealer code, a GSTIN and an approval
 * state — so they live here rather than being copied into the new file and
 * drifting the first time someone edits one of them.
 *
 * Presentational only: every value is a prop. The dashboards own the fetching.
 */

import { BadgeCheck, Building2, CheckCircle2, Clock3 } from "lucide-react";

/** Amber "under review" / emerald "active" banner pair. */
export function DealerAccountStatusBanner({
  isApproved,
  activeMessage,
}: {
  isApproved: boolean;
  /**
   * What the dealer can actually do once active — which differs by dealer type,
   * so the caller supplies it. Promising a scrap dealer "leads, loan workflows,
   * orders and inventory" would describe a portal they do not have.
   */
  activeMessage: string;
}) {
  if (!isApproved) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-xl bg-amber-100 p-2">
            <Clock3 className="h-5 w-5 text-amber-700" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-amber-900">Account under review</h2>
            <p className="mt-1 text-sm text-amber-800">
              Your onboarding has been submitted successfully. Once iTarang approves your
              documents and activates your dealer account, your full dealer dashboard will be
              unlocked.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-xl bg-emerald-100 p-2">
          <CheckCircle2 className="h-5 w-5 text-emerald-700" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-emerald-900">Account active</h2>
          <p className="mt-1 text-sm text-emerald-800">{activeMessage}</p>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  tone = "grey",
}: {
  label: string;
  value: string;
  tone?: "grey" | "blue";
}) {
  if (tone === "blue") {
    return (
      <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4">
        <p className="text-xs uppercase tracking-wide text-blue-700">{label}</p>
        <p className="mt-2 inline-flex rounded-full border border-blue-200 bg-white px-3 py-1 text-sm font-bold text-[#1F5C8F]">
          {value}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-2 text-base font-semibold text-gray-900">{value}</p>
    </div>
  );
}

export function DealerIdentityCard({
  dealerName,
  dealerId,
  companyType,
  gstNumber,
  dealerTypeLabel,
}: {
  dealerName: string;
  dealerId: string;
  companyType: string;
  gstNumber: string;
  /**
   * E-202 business type, already labelled. Shown because it now DECIDES which
   * modules the dealer has — a dealer wondering where a menu went should be
   * able to see the reason on their own dashboard.
   */
  dealerTypeLabel?: string | null;
}) {
  return (
    <div className="rounded-2xl border border-[#E3E8EF] bg-white p-6 shadow-sm lg:col-span-2">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-[#1F5C8F]">
            Dealer Identity
          </p>
          <h2 className="mt-2 text-xl font-bold text-[#173F63]">{dealerName}</h2>
          <p className="mt-2 text-sm text-gray-500">
            This dealer profile reflects the latest approved onboarding status from iTarang.
          </p>
        </div>

        <div className="hidden h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-[#1F5C8F] sm:flex">
          <BadgeCheck className="h-6 w-6" />
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Dealer Name" value={dealerName} />
        <Field label="Dealer ID" value={dealerId} tone="blue" />
        <Field label="Company Type" value={companyType} />
        <Field label="GST Number" value={gstNumber} />
        {dealerTypeLabel && <Field label="Dealer Type" value={dealerTypeLabel} />}
      </div>
    </div>
  );
}

export function DealerOnboardingStatusCard({
  isApproved,
  statusLabel,
  financeEnabledValue,
  submittedAt,
  approvedAt,
}: {
  isApproved: boolean;
  statusLabel: string;
  /**
   * Pass null to omit the row entirely — a scrap dealer does not sell financed
   * batteries, so "Finance Enabled: No" reads as a missing capability rather
   * than an irrelevant one.
   */
  financeEnabledValue: string | null;
  submittedAt?: string | null;
  approvedAt?: string | null;
}) {
  return (
    <div className="rounded-2xl border border-[#E3E8EF] bg-white p-6 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
          <Building2 className="h-5 w-5" />
        </div>
        <div>
          <h3 className="font-bold text-gray-900">Onboarding Status</h3>
          <p className="text-sm text-gray-500">Application snapshot</p>
        </div>
      </div>

      <div className="mt-6 space-y-4">
        <div
          className={`rounded-xl border px-4 py-3 ${
            isApproved ? "border-emerald-100 bg-emerald-50" : "border-amber-100 bg-amber-50"
          }`}
        >
          <p
            className={`text-xs uppercase tracking-wide ${
              isApproved ? "text-emerald-700" : "text-amber-700"
            }`}
          >
            Current Status
          </p>
          <p
            className={`mt-1 text-sm font-semibold ${
              isApproved ? "text-emerald-800" : "text-amber-800"
            }`}
          >
            {statusLabel}
          </p>
        </div>

        {financeEnabledValue !== null && (
          <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-gray-500">Finance Enabled</p>
            <p className="mt-1 text-sm font-semibold text-gray-900">{financeEnabledValue}</p>
          </div>
        )}

        <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-gray-500">Submitted At</p>
          <p className="mt-1 text-sm font-semibold text-gray-900">
            {submittedAt ? new Date(submittedAt).toLocaleString() : "Not available"}
          </p>
        </div>

        {approvedAt && (
          <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-gray-500">Approved At</p>
            <p className="mt-1 text-sm font-semibold text-gray-900">
              {new Date(approvedAt).toLocaleString()}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
