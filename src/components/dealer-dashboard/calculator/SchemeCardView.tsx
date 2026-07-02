import { CheckCircle2, TrendingUp, Star } from "lucide-react";
import { inr, type SchemeCard } from "./types";

// One loan-scheme card. Itemises the upfront, ending in the SINGLE "Total payable
// today" figure (the engine's totalUpfront) — never re-summed from the parts.
export function SchemeCardView({ card }: { card: SchemeCard }) {
  const isStretch = card.tier === "stretch";
  const b = card.breakdown;

  return (
    <div
      className={`rounded-2xl border bg-white p-5 shadow-sm transition ${
        card.recommended ? "border-emerald-400 ring-2 ring-emerald-100" : "border-gray-200"
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <p className="text-lg font-black text-gray-900">{card.nbfc}</p>
          <p className="text-xs text-gray-500">
            Scheme {card.schemeCode} · {card.tenure}-month tenure
            {card.advance > 0 ? ` · ${card.advance} advance EMI` : ""}
          </p>
        </div>
        {card.recommended && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700">
            <Star className="h-3 w-3 fill-emerald-500 text-emerald-500" />
            {card.recommendationLabel ?? "Recommended"}
          </span>
        )}
      </div>

      <div className="flex items-baseline gap-2 mb-4">
        <span className="text-3xl font-black text-gray-900">{inr(card.emi)}</span>
        <span className="text-sm text-gray-500">/ month × {card.remainingMonths}</span>
      </div>

      <dl className="space-y-1.5 text-sm">
        <Row label="Asset price" value={inr(card.priceToDriver)} />
        <Row label="Loan amount" value={inr(card.loanAmount)} />
        <Row label="Down payment" value={inr(b.downPayment)} />
        {b.advanceInstallmentsTotal > 0 && (
          <Row label={`Advance instalments (${card.advance})`} value={inr(b.advanceInstallmentsTotal)} />
        )}
        <Row
          label="Other upfront charges"
          value={inr(b.nbfcFileFee + b.processingFee + b.interestChargedUpfront + b.advanceInterest)}
        />
      </dl>

      <div className="mt-3 flex items-center justify-between rounded-xl bg-gray-900 px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-300">Total payable today</span>
        <span className="text-xl font-black text-white">{inr(card.totalUpfront)}</span>
      </div>

      <p className="mt-2 text-[11px] text-gray-400">
        Est. total payable {inr(card.estimatedTotalPayable)} (upfront + EMIs)
      </p>

      {isStretch && card.stretch && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <TrendingUp className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {card.stretch.failsUpfront && card.stretch.upfrontGap > 0
              ? `Pay ${inr(card.stretch.upfrontGap)} more upfront to unlock this scheme.`
              : card.stretch.failsEmi && card.stretch.requiredEmi > 0
                ? `Accept an EMI of ${inr(card.stretch.requiredEmi)} to unlock this scheme.`
                : "Close to qualifying."}
          </span>
        </div>
      )}

      {!isStretch && (
        <div className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-600">
          <CheckCircle2 className="h-3.5 w-3.5" /> Qualifies for this customer
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-semibold text-gray-800">{value}</dd>
    </div>
  );
}
