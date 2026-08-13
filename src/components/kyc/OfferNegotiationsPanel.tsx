"use client";

/**
 * E-238 — read-only admin view of the dealer <-> NBFC offer negotiations on a
 * lead, for the NBFC Actions tab of the admin KYC review.
 *
 * iTarang needs to see what was actually asked for and agreed before the
 * sanction is written, but does not participate: there is deliberately no way
 * to post into the thread from here. The Admin -> NBFC message channel already
 * exists separately (Acquire change request #3) and is the right tool for
 * saying something; this is evidence, not a chat.
 *
 * Self-hides when no NBFC on the lead has been negotiated with.
 */
import { useCallback, useEffect, useState } from "react";

import OfferNegotiationThread from "@/components/nbfc-portal/OfferNegotiationThread";
import type { NegotiationRound } from "@/components/nbfc-portal/OfferNegotiationThread";

interface Item {
  nbfc_id: number;
  nbfc_id_code: string | null;
  nbfc_short_name: string | null;
  nbfc_legal_name: string | null;
  status: string;
  negotiation_status: string | null;
  fixed_at: string | null;
  ceo_approval_status: string | null;
  negotiation: NegotiationRound[];
}

const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  open: { label: "Open", cls: "bg-sky-50 text-sky-700 border-sky-200" },
  dealer_countered: {
    label: "Awaiting NBFC",
    cls: "bg-violet-50 text-violet-700 border-violet-200",
  },
  fixed: { label: "Fixed", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
};

export default function OfferNegotiationsPanel({ leadId }: { leadId: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/leads/${leadId}/offer-negotiations`, {
        cache: "no-store",
      });
      const json = (await res.json()) as { success?: boolean; data?: { items?: Item[] } };
      if (json.success && json.data?.items) setItems(json.data.items);
    } catch {
      // best-effort — this panel is evidence, never a blocker on the review
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || items.length === 0) return null;

  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
      <h3 className="text-sm font-black uppercase tracking-wider text-slate-600">
        Offer Negotiations
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        What the dealer asked for and how each lender answered, in order. Read-only.
      </p>

      <div className="mt-4 space-y-5">
        {items.map((item) => {
          const pill = item.negotiation_status ? STATUS_PILL[item.negotiation_status] : null;
          return (
            <div key={item.nbfc_id} className="rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="font-bold text-slate-800">
                  {item.nbfc_short_name || item.nbfc_legal_name || `NBFC #${item.nbfc_id}`}
                  {item.nbfc_id_code && (
                    <span className="ml-1.5 text-xs font-normal text-slate-400">
                      ({item.nbfc_id_code})
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {pill && (
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${pill.cls}`}
                    >
                      {pill.label}
                    </span>
                  )}
                  {item.ceo_approval_status === "pending" && (
                    <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                      Held for CEO
                    </span>
                  )}
                </div>
              </div>

              {/* collapsible={false} — an admin opening this panel came here to
                  read it, so it should not need a second click. */}
              <OfferNegotiationThread
                rounds={item.negotiation}
                viewer="admin"
                collapsible={false}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
