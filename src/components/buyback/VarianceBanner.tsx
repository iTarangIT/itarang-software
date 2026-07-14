"use client";

/**
 * The dealer's count-variance acknowledgement (M05 AC).
 *
 * THE GATE THIS COMPLETES: when iTarang collects fewer batteries than the dealer
 * declared, the dealer's payout is HELD until they agree to the collected count.
 * The hold is enforced server-side (assertPayoutAllowed), on BOTH settlement
 * routes.
 *
 * Without this component the gate was a trap rather than a gate: the API to
 * acknowledge existed, but nothing in the dealer's portal called it, so a dealer
 * whose count came up short had their money blocked with no way to release it.
 * The system would have been holding their payment and offering them no button.
 *
 * The numbers are shown line by line, deliberately. "You said 3, we found 2" is a
 * fact a dealer can check against their own records and either accept or dispute.
 * A bare "there was a variance, please confirm" asks them to sign a blank cheque.
 *
 * There is no "dispute" button, and that is the right call: if the dealer
 * disagrees with the count, they do not acknowledge, the payout stays held, and a
 * human sorts it out. A software workflow cannot settle an argument about how many
 * physical batteries were on a truck, and pretending otherwise would only produce
 * a button that lies.
 */

import { useEffect, useState } from "react";

interface Count {
  line_id: string;
  label?: string;
  quantity: number;
}

interface Variance {
  pickup_id: string;
  note: string | null;
  expected: Count[] | null;
  actual: Count[] | null;
  needs_ack: boolean;
  acknowledged_at: string | null;
}

export default function VarianceBanner({ requestId }: { requestId: string }) {
  const [variance, setVariance] = useState<Variance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const res = await fetch(`/api/buyback/requests/${requestId}/variance-ack`);
      const json = await res.json();
      if (cancelled) return;
      setVariance(json?.data?.variance ?? null);
    })();

    return () => {
      cancelled = true;
    };
  }, [requestId, reloadKey]);

  if (!variance) return null;

  const acknowledge = async () => {
    setBusy(true);
    setError(null);

    const res = await fetch(`/api/buyback/requests/${requestId}/variance-ack`, {
      method: "POST",
    });
    const json = await res.json();
    setBusy(false);

    if (!json?.success) {
      setError(json?.error?.message ?? "Could not confirm the count.");
      return;
    }
    setReloadKey((k) => k + 1);
  };

  // Already confirmed — a quiet note, not a banner. The dealer does not need to be
  // shouted at about something they have already dealt with.
  if (!variance.needs_ack) {
    return (
      <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
        You confirmed the collected count
        {variance.acknowledged_at
          ? ` on ${new Date(variance.acknowledged_at).toLocaleDateString("en-IN")}`
          : ""}
        . Your payment is no longer held.
      </div>
    );
  }

  const expected = variance.expected ?? [];
  const actual = new Map((variance.actual ?? []).map((a) => [a.line_id, a.quantity]));

  return (
    <div className="mt-6 rounded-xl border-2 border-amber-300 bg-amber-50 p-5">
      <div className="text-xs font-bold uppercase tracking-wide text-amber-800">
        Action needed — your payment is on hold
      </div>

      <p className="mt-2 text-sm text-amber-900">
        When we collected your batteries, the count did not match what you declared.
        We cannot pay you until you confirm the numbers we actually collected —
        otherwise we would be paying for batteries that were not there.
      </p>

      {/* Line by line. A dealer can check "you said 3, we found 2" against their own
          records; a bare "there was a variance" asks them to sign a blank cheque. */}
      <div className="mt-4 overflow-hidden rounded-lg border border-amber-200 bg-white">
        <div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-amber-100 bg-amber-50/60 px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-amber-700">
          <span>Battery</span>
          <span className="text-right">You declared</span>
          <span className="text-right">We collected</span>
        </div>

        {expected.map((e) => {
          const got = actual.get(e.line_id) ?? 0;
          const off = got !== e.quantity;

          return (
            <div
              key={e.line_id}
              className={`grid grid-cols-[1fr_auto_auto] gap-4 border-b border-slate-50 px-3 py-2 text-sm last:border-b-0 ${
                off ? "bg-red-50" : ""
              }`}
            >
              <span className="font-medium text-slate-700">{e.label ?? e.line_id}</span>
              <span className="text-right tabular-nums text-slate-600">{e.quantity}</span>
              <span
                className={`text-right font-bold tabular-nums ${
                  off ? "text-red-600" : "text-slate-700"
                }`}
              >
                {got}
                {off && (
                  <span className="ml-1 text-xs font-semibold">
                    ({got < e.quantity ? "−" : "+"}
                    {Math.abs(got - e.quantity)})
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {variance.note && (
        <p className="mt-2 text-xs text-amber-800">{variance.note}</p>
      )}

      {error && <div className="mt-3 text-xs font-semibold text-red-600">{error}</div>}

      <button
        onClick={acknowledge}
        disabled={busy}
        className="mt-4 w-full rounded-lg bg-amber-600 py-2.5 text-sm font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
      >
        {busy ? "Confirming…" : "Confirm the collected count and release my payment"}
      </button>

      <p className="mt-2 text-center text-[11px] text-amber-700">
        If these numbers look wrong to you, do not confirm — contact us instead. Your
        payment stays held until this is agreed.
      </p>
    </div>
  );
}
