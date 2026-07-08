"use client";

/**
 * CaseWorkspaceSheet — right-side drawer that opens when an NBFC user clicks
 * a battery row on /nbfc/batteries. Replaces the old inline BatteryRowDrawer
 * with the prototype's case-workspace layout (BRD §6.4.5 + §6.1.6).
 *
 * Sections:
 *   1. Header: case chip + "VERY HIGH RISK — IMMOBILISATION ELIGIBLE" badge
 *   2. IdentityCards (8 fields)
 *   3. WhyFlaggedPanel — confidence + last-updated + reasons + CDS/PCI chips
 *   4. Tabs: Telemetry / EMI History / Usage Pattern / Action History
 *   5. WhyThisMattersPanel — default probability + freshness + limits
 *   6. RecommendedActions radio + "Continue to action" → opens an action modal
 *
 * Data flow:
 *   - On open, fetches /api/nbfc/loans/[loanSanctionId]/case-detail.
 *   - Tab content fetches lazily (EMI / Usage / Action History each own a hook).
 *   - Action modals call the existing POST routes under /api/nbfc/actions/**.
 */
import { useEffect, useMemo, useState } from "react";
import IdentityCards from "./case-workspace/IdentityCards";
import WhyFlaggedPanel from "./case-workspace/WhyFlaggedPanel";
import WhyThisMattersPanel from "./case-workspace/WhyThisMattersPanel";
import TelemetryTab from "./case-workspace/TelemetryTab";
import EmiHistoryTab from "./case-workspace/EmiHistoryTab";
import UsagePatternTab from "./case-workspace/UsagePatternTab";
import ActionHistoryTab from "./case-workspace/ActionHistoryTab";
import RecommendedActions from "./case-workspace/RecommendedActions";
import PaymentReminderModal from "./case-workspace/modals/PaymentReminderModal";
import FieldVisitModal from "./case-workspace/modals/FieldVisitModal";
import ImmobilisationModal from "./case-workspace/modals/ImmobilisationModal";
import RestructuringModal from "./case-workspace/modals/RestructuringModal";
import type {
  CaseDetailResponse,
  RecommendedActionKey,
} from "./case-workspace/types";

interface Props {
  open: boolean;
  loanSanctionId: string | null;
  batteryCode: string | null;
  bands: { low_mid: number; mid_high: number };
  onClose: () => void;
  /** Hard-coded brand strings for the borrower notice. Pulled from BRD §6.4.3. */
  lenderLegalName?: string;
  grievanceUrl?: string;
  helpline?: string;
}

type TabKey = "telemetry" | "emi" | "usage" | "actions";

export function CaseWorkspaceSheet({
  open,
  loanSanctionId,
  batteryCode,
  bands,
  onClose,
  lenderLegalName = "Kosh Lending Co.",
  grievanceUrl = "https://kosh.example.com/grievance",
  helpline = "+91 1800-XXX-XXXX",
}: Props) {
  const [detail, setDetail] = useState<CaseDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("telemetry");
  const [activeModal, setActiveModal] = useState<RecommendedActionKey | null>(
    null,
  );
  const [submittedAt, setSubmittedAt] = useState<number>(0);

  useEffect(() => {
    if (!open || !loanSanctionId) return;
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
    async function load(id: string) {
      try {
        const res = await fetch(
          `/api/nbfc/loans/${encodeURIComponent(id)}/case-detail`,
          { cache: "no-store" },
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
          return;
        }
        setDetail(body as CaseDetailResponse);
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    }
    load(loanSanctionId);
    return () => {
      cancelled = true;
    };
  }, [open, loanSanctionId, submittedAt]);

  const headerRisk = useMemo(() => {
    if (!detail) return null;
    const cds = detail.flagged.cds_score;
    if (cds == null) return null;
    // Band on the rounded score so the drawer matches the CDS number shown.
    const v = Math.round(cds);
    if (v >= bands.mid_high) return { label: "Very High Risk", tone: "red" };
    if (v >= bands.low_mid) return { label: "Medium Risk", tone: "amber" };
    return { label: "Low Risk", tone: "green" };
  }, [detail, bands]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="case-workspace-title"
      className="fixed inset-0 z-50 flex"
    >
      <button
        type="button"
        aria-label="Close case workspace"
        onClick={onClose}
        className="flex-1 bg-black/50"
      />
      <aside className="flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-white shadow-2xl dark:bg-slate-900">
        <header className="sticky top-0 z-10 border-b border-[color:var(--color-border)] bg-white px-5 py-4 dark:bg-slate-900">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
                Case{" "}
                <span className="text-[color:var(--color-ink)]">
                  {batteryCode ?? "—"}
                </span>{" "}
                ·{" "}
                <span className="text-[color:var(--color-ink)]">
                  {detail?.identity.customer ?? "—"}
                </span>
                {detail?.identity.city ? (
                  <>
                    {" "}· 📍{" "}
                    <span className="text-[color:var(--color-ink)]">
                      {detail.identity.city}
                    </span>
                  </>
                ) : null}
              </p>
              <h2
                id="case-workspace-title"
                className="mt-1 text-base font-semibold text-[color:var(--color-ink)]"
              >
                {detail?.flagged.immobilisation_eligible
                  ? "VERY HIGH RISK — IMMOBILISATION ELIGIBLE"
                  : headerRisk
                    ? `${headerRisk.label.toUpperCase()}`
                    : "Case workspace"}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded p-1 text-xl leading-none text-[color:var(--color-ink-muted)] hover:bg-slate-100"
            >
              ×
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-4 px-5 py-4">
          {loadError ? (
            <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              Failed to load case detail: {loadError}
            </p>
          ) : null}

          {!detail && !loadError ? (
            <p className="text-sm italic text-[color:var(--color-ink-muted)]">
              Loading case detail…
            </p>
          ) : null}

          {detail ? (
            <>
              <IdentityCards identity={detail.identity} />

              <WhyFlaggedPanel
                flagged={detail.flagged}
                loanSanctionId={detail.loan_application_id}
                bands={bands}
              />

              <div>
                <div
                  role="tablist"
                  aria-label="Case detail tabs"
                  className="flex flex-wrap gap-1 border-b border-[color:var(--color-border)]"
                >
                  {(
                    [
                      ["telemetry", "Telemetry"],
                      ["emi", "EMI History"],
                      ["usage", "Usage Pattern"],
                      ["actions", "Action History"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      role="tab"
                      type="button"
                      aria-selected={tab === key}
                      onClick={() => setTab(key)}
                      className={`px-3 py-2 text-sm font-semibold ${
                        tab === key
                          ? "border-b-2 border-sky-500 text-sky-600"
                          : "text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="pt-3">
                  {tab === "telemetry" ? (
                    <TelemetryTab
                      serialNumber={detail.vehicleno}
                      warranty={detail.warranty}
                    />
                  ) : null}
                  {tab === "emi" ? (
                    <EmiHistoryTab
                      loanSanctionId={detail.loan_application_id}
                    />
                  ) : null}
                  {tab === "usage" ? (
                    <UsagePatternTab serialNumber={detail.vehicleno} />
                  ) : null}
                  {tab === "actions" ? (
                    <ActionHistoryTab
                      loanSanctionId={detail.loan_application_id}
                    />
                  ) : null}
                </div>
              </div>

              <WhyThisMattersPanel wm={detail.why_this_matters} />

              <RecommendedActions
                immobilisationEligible={detail.flagged.immobilisation_eligible}
                onContinue={(key) => setActiveModal(key)}
              />
            </>
          ) : null}
        </div>
      </aside>

      {detail ? (
        <>
          <PaymentReminderModal
            open={activeModal === "payment_reminder"}
            onClose={() => setActiveModal(null)}
            loanSanctionId={detail.loan_application_id}
            batteryCode={batteryCode ?? detail.identity.imei ?? "—"}
            borrowerName={detail.identity.customer}
            onSubmitted={() => setSubmittedAt(Date.now())}
          />
          <FieldVisitModal
            open={activeModal === "field_visit"}
            onClose={() => setActiveModal(null)}
            loanSanctionId={detail.loan_application_id}
            batteryCode={batteryCode ?? detail.identity.imei ?? "—"}
            borrowerName={detail.identity.customer}
            onSubmitted={() => setSubmittedAt(Date.now())}
          />
          <ImmobilisationModal
            open={activeModal === "immobilisation"}
            onClose={() => setActiveModal(null)}
            loanApplicationId={detail.loan_application_id}
            imei={detail.identity.imei}
            batteryCode={batteryCode ?? detail.identity.imei ?? "—"}
            borrowerName={detail.identity.customer}
            outstanding={detail.identity.outstanding}
            lenderLegalName={lenderLegalName}
            grievanceUrl={grievanceUrl}
            helpline={helpline}
            onSubmitted={() => setSubmittedAt(Date.now())}
          />
          <RestructuringModal
            open={activeModal === "restructuring"}
            onClose={() => setActiveModal(null)}
            loanApplicationId={detail.loan_application_id}
            batteryCode={batteryCode ?? detail.identity.imei ?? "—"}
            borrowerName={detail.identity.customer}
            currentEmiAmount={detail.emi.emi_amount}
            currentTenureMonths={detail.identity.tenure_months}
            currentEmiDueDom={detail.emi.emi_due_dom}
            outstanding={detail.identity.outstanding}
            lenderLegalName={lenderLegalName}
            grievanceUrl={grievanceUrl}
            helpline={helpline}
            onSubmitted={() => setSubmittedAt(Date.now())}
          />
        </>
      ) : null}
    </div>
  );
}

export default CaseWorkspaceSheet;
