"use client";

/**
 * E-067 — Impact preview modal shown after the admin clicks "Preview impact"
 * on the Risk Rule Engine form. Surfaces the BRD §6.3.3 impact line:
 *
 *   "This change will affect N accounts.
 *    Accounts moving to higher risk band: X."
 *
 * The modal is read-only — the actual commit happens through the
 * dual-approval gate (E-085). We just render the counts here.
 */
export type ImpactPreview = {
  rule_key: string;
  new_value: number;
  affected_accounts: number;
  accounts_moving_to_higher_band: number;
};

type Props = {
  preview: ImpactPreview;
  onClose: () => void;
};

export default function ImpactPreviewModal({ preview, onClose }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h3 className="mb-2 text-lg font-semibold">Impact preview</h3>
        <p className="mb-4 text-sm text-slate-700">
          Proposed change: <span className="font-mono">{preview.rule_key}</span>{" "}
          → <span className="font-mono">{preview.new_value}</span>
        </p>
        <div className="space-y-2 text-sm">
          <div>
            This change will affect{" "}
            <strong>{preview.affected_accounts}</strong> account
            {preview.affected_accounts === 1 ? "" : "s"}.
          </div>
          <div>
            Accounts moving to higher risk band:{" "}
            <strong>{preview.accounts_moving_to_higher_band}</strong>.
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border px-3 py-1"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          To commit this change, raise it via the dual-approval gate. The
          second approver must sign off before the value is written.
        </p>
      </div>
    </div>
  );
}
