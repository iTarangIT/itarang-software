"use client";

/**
 * E-067 — Risk Rule Engine admin form.
 *
 * Reads the eight platform thresholds from /api/admin/nbfc/risk-rules and lets
 * the admin propose a new value per rule. Clicking "Preview impact" calls
 * /api/admin/nbfc/risk-rules/preview and shows the BRD-mandated impact line
 * ("This change will affect N accounts. Accounts moving to higher risk band:
 * X.") via <ImpactPreviewModal />.
 *
 * IMPORTANT: this form does NOT commit the change. Per BRD §6.3.3 the actual
 * commit goes through the dual-approval gate (E-085), which is a separate
 * surface that the second approver signs off on.
 */
import { useEffect, useState } from "react";
import ImpactPreviewModal, { type ImpactPreview } from "./ImpactPreviewModal";

type Rule = {
  key: string;
  label: string;
  current_value: number;
  unit: string | null;
};

export default function RiskRuleEngineForm() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [proposed, setProposed] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [preview, setPreview] = useState<
    (ImpactPreview & { rule_key: string; new_value: number }) | null
  >(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/nbfc/risk-rules");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (cancel) return;
        setRules(body.rules);
      } catch (e) {
        if (cancel) return;
        setError(e instanceof Error ? e.message : "Failed to load rules");
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  async function handlePreview(rule: Rule) {
    const raw = proposed[rule.key];
    const newValue = Number(raw);
    if (!Number.isFinite(newValue)) {
      setError(`Enter a numeric value for ${rule.label}`);
      return;
    }
    setError(null);
    setPreviewing(rule.key);
    try {
      const res = await fetch("/api/admin/nbfc/risk-rules/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule_key: rule.key, new_value: newValue }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setPreview({
        rule_key: rule.key,
        new_value: newValue,
        affected_accounts: body.affected_accounts,
        accounts_moving_to_higher_band: body.accounts_moving_to_higher_band,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewing(null);
    }
  }

  if (loading) return <div className="p-4">Loading thresholds…</div>;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Risk Rule Engine — Thresholds</h2>
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-3 py-2 text-left">Parameter</th>
              <th className="px-3 py-2 text-left">Current</th>
              <th className="px-3 py-2 text-left">Proposed</th>
              <th className="px-3 py-2 text-left">Unit</th>
              <th className="px-3 py-2 text-left">Action</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.key} className="border-t">
                <td className="px-3 py-2">{r.label}</td>
                <td className="px-3 py-2 font-mono">{r.current_value}</td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="any"
                    className="w-24 rounded border px-2 py-1"
                    value={proposed[r.key] ?? ""}
                    onChange={(e) =>
                      setProposed((p) => ({ ...p, [r.key]: e.target.value }))
                    }
                    placeholder={String(r.current_value)}
                  />
                </td>
                <td className="px-3 py-2 text-slate-500">{r.unit ?? ""}</td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
                    disabled={previewing === r.key || !proposed[r.key]}
                    onClick={() => handlePreview(r)}
                  >
                    {previewing === r.key ? "Previewing…" : "Preview impact"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Threshold changes do not take effect until the second approver signs
        off via the dual-approval gate (E-085).
      </p>
      {preview && (
        <ImpactPreviewModal
          preview={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
