"use client";

/**
 * The scrap vendor's dashboard (E-195, BRD M24).
 *
 * Until now a vendor had no login at all. They received a quotation PDF by
 * email and replied to it, and an admin typed their answer into the admin
 * screen — which is why "the vendor raises the PO" was unmodellable and why
 * admin and vendor actions ended up tangled on one page.
 *
 * Everything rendered here comes from /api/vendor/threads, which is scoped to
 * this vendor and masked twice over. There is deliberately no dealer name, no
 * address line, and no price except the ones on this vendor's own thread: what
 * we asked, what they offered, what was struck. If you are adding a field to
 * this page, it has to survive that rule — see toVendorThread's contract test.
 */

import { useEffect, useState } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { Card, EmptyState, KpiCard, PageHeader } from "@/components/buyback/ui";
import { inr } from "@/lib/buyback/format";

interface VendorLine {
  line_id: string;
  spec_label: string;
  condition: string;
  quantity: number;
  ask_price: number | string | null;
  counter_price: number | string | null;
  agreed_price: number | string | null;
}

interface VendorThread {
  thread_id: string;
  quotation_no: string;
  status: "SENT" | "COUNTERED" | "AGREED" | "LOST";
  pickup_city: string | null;
  pickup_state: string | null;
  lines: VendorLine[];
  total_units: number;
  ask_total: number | null;
  counter_total: number | null;
  agreed_total: number | null;
  sent_at: string | null;
  responded_at: string | null;
  can_respond: boolean;
}

const STATUS_STYLE: Record<VendorThread["status"], string> = {
  SENT: "bg-amber-50 text-amber-700 border-amber-200",
  COUNTERED: "bg-blue-50 text-blue-700 border-blue-200",
  AGREED: "bg-green-50 text-green-700 border-green-200",
  LOST: "bg-slate-100 text-slate-500 border-slate-200",
};

const STATUS_LABEL: Record<VendorThread["status"], string> = {
  SENT: "Awaiting your response",
  COUNTERED: "Your counter is with iTarang",
  AGREED: "Agreed — yours",
  LOST: "Closed",
};

export default function VendorPortalPage() {
  const { user } = useAuth();
  const [threads, setThreads] = useState<VendorThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/vendor/threads")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) {
          setError(j?.error?.message ?? "Could not load your quotations.");
          return;
        }
        setThreads(j?.data?.threads ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load your quotations.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const open = threads.filter((t) => t.can_respond);
  const won = threads.filter((t) => t.status === "AGREED");
  const wonValue = won.reduce((sum, t) => sum + (t.agreed_total ?? 0), 0);

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader
          title="Dashboard"
          sub={
            user?.name
              ? `Welcome back, ${user.name} — battery lots offered to you`
              : "Battery lots offered to you"
          }
        />

        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : loading ? (
          <p className="py-16 text-center text-sm text-slate-400">Loading…</p>
        ) : threads.length === 0 ? (
          /* The expected first-run state, and it needs saying: a vendor who has
             just signed up is PENDING, and listRoutableVendors() will not route
             a deal to them until an admin activates them. Without this they
             would reasonably think the portal was broken. */
          <EmptyState
            icon="📭"
            title="No quotations yet"
            body="When iTarang has a battery lot for you, it will appear here. If you have only just registered, an iTarang admin needs to approve your account first."
          />
        ) : (
          <>
            <div className="mb-[22px] grid grid-cols-2 gap-3.5 sm:grid-cols-3">
              <KpiCard label="Awaiting your response" value={open.length} accent="text-amber-500" />
              <KpiCard label="Lots won" value={won.length} accent="text-green-600" />
              <KpiCard label="Value won" variant="navy" value={inr(wonValue)} />
            </div>

            <Card title="Your quotations">
              <ul className="divide-y divide-slate-100">
                {threads.map((t) => (
                  <li key={t.thread_id} className="px-[18px] py-3.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-bold text-slate-900">
                        {t.quotation_no}
                      </span>
                      <span
                        className={`rounded border px-2 py-0.5 text-[11.5px] font-semibold ${STATUS_STYLE[t.status]}`}
                      >
                        {STATUS_LABEL[t.status]}
                      </span>
                      <span className="text-[12.5px] text-slate-400">
                        {t.total_units} units
                        {t.pickup_city
                          ? ` · collect from ${[t.pickup_city, t.pickup_state]
                              .filter(Boolean)
                              .join(", ")}`
                          : ""}
                      </span>
                      <span className="ml-auto text-[13px] font-semibold tabular-nums text-slate-900">
                        {t.agreed_total !== null
                          ? `${inr(t.agreed_total)} agreed`
                          : t.counter_total !== null
                            ? `${inr(t.counter_total)} your offer`
                            : t.ask_total !== null
                              ? `${inr(t.ask_total)} asked`
                              : "—"}
                      </span>
                    </div>

                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                      {t.lines.map((l) => (
                        <span key={l.line_id} className="text-[12px] text-slate-500">
                          {l.spec_label} · {l.condition} ×{l.quantity}
                          {l.ask_price !== null ? ` @ ${inr(Number(l.ask_price))}/u` : ""}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
