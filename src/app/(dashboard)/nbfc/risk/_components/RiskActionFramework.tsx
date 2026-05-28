/**
 * BRD §6.1.6 — Risk Action Framework.
 *
 * Two parts:
 *   1. The 5-row action matrix (Action × Approval × Reversible × Audit).
 *   2. The mandatory Immobilisation Borrower Notice Preview — 5 components
 *      required by RBI Digital Lending Directions 2025 + a (preview-disabled)
 *      "I confirm the notice is accurate" checkbox.
 *
 * Server component. The matrix is informational; per-borrower action submission
 * lives elsewhere (e.g. ImmobilisationInitiateForm) and re-renders this preview
 * with real loan context before allowing submission.
 */

interface TenantLegal {
  legal_name: string | null;
  display_name: string;
  grievance_url: string | null;
  grievance_helpline: string | null;
}

interface ActionRow {
  action: string;
  approval: string;
  approvalTone: string;
  reversible: string;
  reversibleTone: string;
  auditLog: string;
}

const ACTION_ROWS: ActionRow[] = [
  {
    action: "Send Payment Reminder",
    approval: "Single — NBFC User",
    approvalTone: "bg-slate-100 text-slate-700",
    reversible: "N/A",
    reversibleTone: "bg-slate-100 text-slate-500",
    auditLog: "Yes — auto",
  },
  {
    action: "Request Field Visit",
    approval: "Single — NBFC Manager",
    approvalTone: "bg-slate-100 text-slate-700",
    reversible: "Yes",
    reversibleTone: "bg-emerald-50 text-emerald-700",
    auditLog: "Yes — manual reason required",
  },
  {
    action: "Request Immobilisation",
    approval: "Dual — Risk Head + Ops",
    approvalTone: "bg-amber-50 text-amber-800",
    reversible: "Yes — re-mobilisation after EMI settlement",
    reversibleTone: "bg-emerald-50 text-emerald-700",
    auditLog: "Yes — full borrower notice preview required",
  },
  {
    action: "Review for Loan Restructuring",
    approval: "Dual — Risk Head + Credit Manager",
    approvalTone: "bg-amber-50 text-amber-800",
    reversible: "Depends on terms",
    reversibleTone: "bg-amber-50 text-amber-700",
    auditLog: "Yes — before/after terms logged",
  },
  {
    action: "Flag for Recovery",
    approval: "Single — Risk Head",
    approvalTone: "bg-slate-100 text-slate-700",
    reversible: "No — permanent flag",
    reversibleTone: "bg-red-50 text-red-700",
    auditLog: "Yes",
  },
];

export default function RiskActionFramework({ tenant }: { tenant: TenantLegal }) {
  const lenderName = tenant.legal_name ?? tenant.display_name;
  const lenderNameMissingLegal = !tenant.legal_name;
  const grievanceUrl = tenant.grievance_url ?? "https://itarang.com/grievance";
  const grievanceHelpline = tenant.grievance_helpline ?? "1800-XXX-XXXX";

  return (
    <section className="space-y-6">
      <div>
        <p className="section-label-muted">BRD §6.1.6</p>
        <h2 className="text-xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
          Risk Action Framework
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1 max-w-3xl">
          Every NBFC-initiated action on a borrower account follows the
          {" "}
          <strong>Evidence → Decision → Action → Audit</strong> chain. Actions
          are tiered by impact — higher impact requires dual approval and an
          immutable audit log.
        </p>
      </div>

      {/* 5-row action matrix */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[820px]">
          <thead className="bg-slate-50 dark:bg-slate-900 text-xs uppercase tracking-widest text-slate-500">
            <tr>
              <th className="px-3 py-2.5 text-left font-bold">Action</th>
              <th className="px-3 py-2.5 text-left font-bold">Approval Required</th>
              <th className="px-3 py-2.5 text-left font-bold">Reversible?</th>
              <th className="px-3 py-2.5 text-left font-bold">Audit Log</th>
            </tr>
          </thead>
          <tbody>
            {ACTION_ROWS.map((r) => (
              <tr key={r.action} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-3 py-2.5 font-semibold text-slate-900 dark:text-slate-100">{r.action}</td>
                <td className="px-3 py-2.5">
                  <span className={`px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide ${r.approvalTone}`}>
                    {r.approval}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span className={`px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide ${r.reversibleTone}`}>
                    {r.reversible}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-xs text-slate-600 dark:text-slate-400">{r.auditLog}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Immobilisation Borrower Notice Preview */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
        <div>
          <p className="section-label-muted">Mandatory Pre-Submission Check</p>
          <h3 className="text-lg font-semibold mt-1">Immobilisation — Borrower Notice Preview</h3>
          <p className="text-xs text-slate-500 mt-1">
            Per RBI Digital Lending Directions 2025, the NBFC portal must show
            this notice before any immobilisation request can be submitted.
            All five components below are mandatory. This preview is shown
            again at the moment of submission on the per-borrower
            immobilisation flow.
          </p>
        </div>

        <ol className="space-y-3">
          <NoticeItem
            n={1}
            label="Lender identity"
            value={lenderName}
            hint={lenderNameMissingLegal ? "Display name shown — legal name not configured for this tenant." : "NBFC legal name (RBI requirement)."}
          />
          <NoticeItem
            n={2}
            label="LSP identity"
            value="iTarang Battery Solutions"
            hint="Loan service provider identity (fixed)."
          />
          <NoticeItem
            n={3}
            label="Outstanding amount + restoration steps"
            value={`₹<outstanding> EMI is currently due. Pay the outstanding amount to restore battery mobility within 2 hours of settlement.`}
            hint="Actual outstanding is substituted at submission time from the loan record."
          />
          <NoticeItem
            n={4}
            label="Grievance channel"
            value={`${grievanceUrl} · ${grievanceHelpline}`}
            hint="Borrower must have an accessible grievance redressal route."
          />
          <NoticeItem
            n={5}
            label="Plain, non-coercive language"
            value="No threats, no abusive wording, no overstated consequences. Restoration path is always disclosed."
            hint="Wording is validated by validateBorrowerNoticeText() at submission."
          />
        </ol>

        <label className="flex items-start gap-2 pt-2 border-t border-slate-100 dark:border-slate-800 text-sm text-slate-500">
          <input
            type="checkbox"
            disabled
            className="mt-0.5 accent-[color:var(--color-brand-navy)] cursor-not-allowed"
            aria-label="I confirm the notice is accurate (preview only)"
          />
          <span>
            <span className="font-semibold text-slate-700 dark:text-slate-300">I confirm the notice is accurate.</span>
            {" "}
            <span className="text-xs italic">(Enabled on the per-borrower immobilisation page once a borrower is selected.)</span>
          </span>
        </label>

        <p className="text-[11px] uppercase tracking-widest text-slate-400 pt-1">
          Per RBI Digital Lending Directions 2025
        </p>
      </div>
    </section>
  );
}

function NoticeItem({
  n,
  label,
  value,
  hint,
}: {
  n: number;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex-none w-6 h-6 rounded-full bg-[color:var(--color-brand-navy)] text-white text-xs font-bold flex items-center justify-center">
        {n}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">{label}</p>
        <p className="text-sm text-slate-800 dark:text-slate-200 mt-0.5 break-words">{value}</p>
        {hint ? <p className="text-xs text-slate-500 mt-0.5">{hint}</p> : null}
      </div>
    </li>
  );
}
