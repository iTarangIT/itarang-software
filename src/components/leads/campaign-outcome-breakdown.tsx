// AI dialer review (23 Oct 2026, point 9) — the campaign's outcome breakdown:
// how every call was categorised (src/lib/ai-dialer/callCategory.ts), counted
// once per lead by its latest dial, plus the callbacks it produced. Each tile
// filters the lead table below to that category.

"use client";

import {
  CALL_CATEGORY_LABELS,
  CALL_CATEGORY_ORDER,
  type CallCategory,
} from "@/lib/ai-dialer/callCategory";
import type { CampaignOutcomeReport } from "@/lib/ai-dialer/campaignOutcomes";

// Shown even at zero — the questions the team asks of every campaign.
const ALWAYS_SHOWN = new Set<CallCategory>([
  "interested",
  "sales_manager_request",
  "callback_sales",
  "callback_ai",
  "disconnected",
  "not_interested",
]);

const TONE: Record<CallCategory, string> = {
  interested: "bg-emerald-50 text-emerald-800 border-emerald-200",
  sales_manager_request: "bg-rose-50 text-rose-800 border-rose-200",
  callback_sales: "bg-orange-50 text-orange-800 border-orange-200",
  callback_ai: "bg-sky-50 text-sky-800 border-sky-200",
  disconnected: "bg-amber-50 text-amber-800 border-amber-200",
  no_interest_signal: "bg-gray-50 text-gray-700 border-gray-200",
  not_interested: "bg-zinc-100 text-zinc-700 border-zinc-200",
  not_relevant: "bg-zinc-100 text-zinc-700 border-zinc-200",
  needs_review: "bg-violet-50 text-violet-800 border-violet-200",
  unavailable: "bg-gray-50 text-gray-600 border-gray-200",
  hung_up: "bg-gray-50 text-gray-600 border-gray-200",
  wrong_number: "bg-gray-50 text-gray-600 border-gray-200",
  failed: "bg-gray-50 text-gray-600 border-gray-200",
};

const HINT: Partial<Record<CallCategory, string>> = {
  interested: "Qualified on the call, or shared at least one business detail.",
  sales_manager_request: "Asked to speak to a person — sent to Ready to assign.",
  callback_sales: "Agreed to a callback — sent to Ready to assign for a Sales Manager.",
  callback_ai: "Older calls only — a simple callback the AI was to make.",
  disconnected: "Cut off mid-conversation — redialled automatically (within the retry budget).",
  no_interest_signal: "Spoke, but shared nothing and asked for nothing.",
  needs_review: "The transcript could not be analysed — retried in the background.",
  unavailable: "No answer, busy, rejected, voicemail or silent.",
};

export function CampaignOutcomeBreakdown({
  outcomes,
  selected,
  onSelect,
}: {
  outcomes: CampaignOutcomeReport | undefined;
  selected: CallCategory | null;
  onSelect: (c: CallCategory | null) => void;
}) {
  if (!outcomes) return null;
  if (!outcomes.available) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-5 py-4 text-xs text-gray-500">
        Call outcome categories are not recorded on this database yet (migration E-356).
      </div>
    );
  }

  const tiles = CALL_CATEGORY_ORDER.filter(
    (c) => ALWAYS_SHOWN.has(c) || outcomes.byCategory[c] > 0 || c === selected,
  );
  const cb = outcomes.callbacks;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900">Call outcomes</h2>
        <p className="text-xs text-gray-500 tabular-nums">
          {outcomes.leads} lead{outcomes.leads === 1 ? "" : "s"} · {outcomes.connectedLeads} connected ·{" "}
          {outcomes.dials} dial{outcomes.dials === 1 ? "" : "s"} ({outcomes.calls} answered)
          {outcomes.retryBooked > 0 && ` · ${outcomes.retryBooked} retry booked`}
        </p>
      </div>
      <p className="mt-1 text-xs text-gray-500 tabular-nums">
        Callbacks: {cb.salesOpen} open with sales · {cb.aiOpen} open with the AI · {cb.done} done
        {cb.expired > 0 && ` · ${cb.expired} not reached`}
        {cb.cancelled > 0 && ` · ${cb.cancelled} cancelled`}
      </p>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {tiles.map((c) => {
          const active = selected === c;
          return (
            <button
              key={c}
              type="button"
              title={HINT[c]}
              aria-pressed={active}
              onClick={() => onSelect(active ? null : c)}
              className={`w-full text-left rounded-xl border px-3 py-2 cursor-pointer transition-shadow hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${TONE[c]} ${
                active ? "ring-2 ring-emerald-500/50" : ""
              }`}
            >
              <span className="block text-[11px] font-medium uppercase tracking-wider opacity-80">
                {CALL_CATEGORY_LABELS[c]}
              </span>
              <span className="block text-xl font-bold tabular-nums">{outcomes.byCategory[c]}</span>
              {outcomes.byCategoryCalls[c] > outcomes.byCategory[c] && (
                <span className="block text-[10px] opacity-70 tabular-nums">
                  {outcomes.byCategoryCalls[c]} dials
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CallCategoryBadge({ category }: { category: string | null | undefined }) {
  if (!category || !(category in CALL_CATEGORY_LABELS)) return null;
  const c = category as CallCategory;
  return (
    <span className={`mt-1 inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${TONE[c]}`}>
      {CALL_CATEGORY_LABELS[c]}
    </span>
  );
}
