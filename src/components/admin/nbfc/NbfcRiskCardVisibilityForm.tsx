"use client";

/**
 * NbfcRiskCardVisibilityForm — E-199.
 *
 * Admin picks exactly which risk-hypothesis cards an NBFC partner may see on
 * their /nbfc/risk dashboard. STRICT allowlist: only checked cards are visible;
 * everything else is hidden on every re-run. Saving PUTs the checked
 * hypothesis_ids to /api/admin/nbfc/{id}/risk-cards, which replaces the tenant's
 * enabled set.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

export interface RiskCardCatalogueItem {
  id: string;
  slug: string;
  title: string;
  description: string;
  source: string; // "human" | "llm-v1"
}

interface Props {
  nbfcId: number;
  catalogue: RiskCardCatalogueItem[];
  initialSelected: string[];
}

// Display grouping. "human" = hand-coded, human-reviewed evaluators; anything
// else is agent-generated. Hand-coded first — they're the vetted ones.
const GROUPS: Array<{ key: string; label: string; match: (s: string) => boolean }> = [
  { key: "human", label: "Hand-coded (human-reviewed)", match: (s) => s === "human" },
  { key: "ai", label: "AI-generated", match: (s) => s !== "human" },
];

export default function NbfcRiskCardVisibilityForm({
  nbfcId,
  catalogue,
  initialSelected,
}: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  const grouped = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        items: catalogue.filter((c) => g.match(c.source)),
      })).filter((g) => g.items.length > 0),
    [catalogue],
  );

  function toggle(id: string) {
    setSavedOk(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setGroup(ids: string[], on: boolean) {
    setSavedOk(false);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const res = await fetch(`/api/admin/nbfc/${nbfcId}/risk-cards`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hypothesis_ids: [...selected] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.message || `Save failed (${res.status})`);
      }
      setSavedOk(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const totalSelected = selected.size;

  return (
    <div className="space-y-6" data-testid="nbfc-risk-card-visibility-form">
      <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-4 text-sm text-[color:var(--color-ink-muted)]">
        The partner sees <strong className="text-[color:var(--color-brand-navy)]">only</strong> the
        cards you check below — {totalSelected} selected of {catalogue.length}. Uncheck everything to
        hide the Risk dashboard entirely. Newly created cards are hidden until you enable them here.
      </div>

      {grouped.map((g) => {
        const ids = g.items.map((i) => i.id);
        const allOn = ids.every((id) => selected.has(id));
        const anyOn = ids.some((id) => selected.has(id));
        const countOn = ids.filter((id) => selected.has(id)).length;
        return (
          <section key={g.key} className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
                {g.label}{" "}
                <span className="font-normal text-[color:var(--color-ink-muted)]">
                  ({countOn}/{ids.length})
                </span>
              </h3>
              <div className="flex items-center gap-2 text-[13px]">
                <button
                  type="button"
                  onClick={() => setGroup(ids, true)}
                  disabled={allOn}
                  className="px-2.5 h-7 rounded-md border border-[color:var(--color-border)] font-medium disabled:opacity-40 hover:bg-white"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setGroup(ids, false)}
                  disabled={!anyOn}
                  className="px-2.5 h-7 rounded-md border border-[color:var(--color-border)] font-medium disabled:opacity-40 hover:bg-white"
                >
                  Clear all
                </button>
              </div>
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {g.items.map((c) => {
                const on = selected.has(c.id);
                return (
                  <li key={c.id}>
                    <label
                      className={`flex gap-3 items-start rounded-lg border p-3 cursor-pointer transition-colors ${
                        on
                          ? "border-[color:var(--color-brand-sky)] bg-[color:var(--color-brand-sky)]/5"
                          : "border-[color:var(--color-border)] hover:bg-[color:var(--color-bg)]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4"
                        checked={on}
                        onChange={() => toggle(c.id)}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-[color:var(--color-brand-navy)]">
                          {c.title}
                        </span>
                        <span className="block text-[11px] font-mono text-[color:var(--color-ink-muted)]">
                          {c.slug}
                        </span>
                        {c.description ? (
                          <span className="block mt-1 text-xs text-[color:var(--color-ink-muted)] line-clamp-2">
                            {c.description}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {error ? (
        <div className="flex items-center gap-2 text-sm text-red-600">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      ) : null}
      {savedOk ? (
        <div className="flex items-center gap-2 text-sm text-emerald-600">
          <CheckCircle2 className="h-4 w-4" />
          Saved — the partner now sees {totalSelected} card{totalSelected === 1 ? "" : "s"}.
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 h-10 rounded-lg text-sm font-semibold text-white shadow-sm disabled:opacity-60"
          style={{ background: "var(--color-brand-sky)" }}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save selection
        </button>
        <span className="text-sm text-[color:var(--color-ink-muted)]">
          {totalSelected} of {catalogue.length} cards visible
        </span>
      </div>
    </div>
  );
}
