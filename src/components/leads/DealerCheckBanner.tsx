"use client";

// E-390 — Battery Pool diagram 1: the dealer-assignment check on a lead page.
// Pending → "waiting for iTarang House"; rejected → the reason and, for the
// person who picked the dealer, the dealers they can re-pick. Renders nothing
// when there is no check, or the viewer is not the initiator / an admin.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type Check = {
  id: string;
  status: "pending" | "approved" | "changed" | "rejected";
  dealer_id: string;
  dealer_name: string;
  reason_label: string;
  decision_reason: string | null;
};

export default function DealerCheckBanner({ leadId, admin = false }: { leadId: string; admin?: boolean }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [options, setOptions] = useState<Array<{ dealerId: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/dealer-check`, { cache: "no-store" });
      const j = await res.json().catch(() => null);
      if (!j?.success) return;
      setCheck(j.data.check ?? null);
      setOptions(j.data.options ?? []);
    } catch {
      /* banner is optional */
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function repick(dealerId: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/dealer-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealer_id: dealerId }),
      });
      const j = await res.json().catch(() => null);
      if (!j?.success) throw new Error(j?.error?.message || "Could not send the dealer back");
      toast.success(`Sent back to iTarang House with ${j.data.dealer.name}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the dealer back");
    } finally {
      setBusy(false);
    }
  }

  if (!check || check.status === "approved" || check.status === "changed") return null;

  if (check.status === "pending") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <span>
          <b>Dealer check:</b> {check.dealer_name} is waiting for iTarang House to confirm ({check.reason_label.toLowerCase()}).
          It goes to the iTarang KYC review and can go to a lender once approved; KYC carries on meanwhile.
        </span>
        {admin && (
          <Link href="/admin/dealer-checks" className="text-xs font-semibold text-[#0047AB] hover:underline">
            Open dealer checks →
          </Link>
        )}
      </div>
    );
  }

  // rejected
  return (
    <div className="space-y-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <p>
        <b>iTarang House rejected the dealer</b> {check.dealer_name}
        {check.decision_reason ? <>: {check.decision_reason}</> : null}. Pick the correct dealer — it goes back to iTarang House.
      </p>
      {admin ? (
        <Link href="/admin/dealer-checks?view=decided" className="text-xs font-semibold text-[#0047AB] hover:underline">
          Open dealer checks →
        </Link>
      ) : options.length ? (
        <div className="flex flex-wrap gap-2">
          {options.map((d) => (
            <button
              key={d.dealerId}
              type="button"
              disabled={busy}
              onClick={() => void repick(d.dealerId)}
              className="rounded-full border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-800 hover:bg-red-100 disabled:opacity-50"
            >
              {d.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs">No other dealer is linked to you — ask iTarang House to assign the dealer.</p>
      )}
    </div>
  );
}
