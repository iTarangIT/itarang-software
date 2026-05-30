"use client";

/**
 * E-NACH track panel — Addendum V0.2 §9. Winner-only, Stage 2.
 * Register (handoff) · Record Result Manually (fallback) · Mark Not Required
 * (Credit/Underwriting waiver). Shows canonical status + a visible attempt
 * count so a struggling lead is obvious (§9.4).
 */
import { useCallback, useEffect, useState } from "react";

type RzpCheckout = {
  order_id: string;
  key_id: string;
  customer_id: string;
  amount: number;
  currency?: string;
  name?: string | null;
  email?: string | null;
  contact?: string | null;
};

// Lazily inject Razorpay Checkout.js (managed e-mandate variant). The project
// loads third-party <script> tags via the document head deliberately (the VPS
// can't use bundled next/font); same pattern here.
function loadRazorpayCheckout(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(false);
    const w = window as unknown as { Razorpay?: unknown };
    if (w.Razorpay) return resolve(true);
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://checkout.razorpay.com/v1/checkout.js"]',
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(true));
      existing.addEventListener("error", () => resolve(false));
      return;
    }
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

type Attempt = {
  id: string;
  status: string;
  enach_ref: string;
  umrn: string | null;
  bank_name: string | null;
  failure_reason: string | null;
  stale_risk: boolean;
  triggered_at: string | null;
  registered_at: string | null;
  skip_reason: string | null;
  created_at: string;
};

type Gate = {
  required: boolean;
  satisfied: boolean;
  status: string | null;
  reason: string;
  attempts: number;
};

type StatusResp = {
  ok: boolean;
  gate?: Gate;
  attempt_count?: number;
  attempts?: Attempt[];
  can_waive?: boolean;
  can_act?: boolean;
  error?: string;
};

const BADGE: Record<string, string> = {
  registered: "bg-emerald-100 text-emerald-700",
  skipped: "bg-slate-200 text-slate-600",
  in_progress: "bg-amber-100 text-amber-700",
  pending: "bg-amber-100 text-amber-700",
  failed: "bg-red-100 text-red-700",
  not_applicable: "bg-slate-100 text-slate-500",
};

export default function EnachTrackPanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<StatusResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiveReason, setWaiveReason] = useState("");
  const [showWaive, setShowWaive] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/nbfc/enach/${leadId}`);
      const j = (await res.json()) as StatusResp;
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openRazorpayCheckout(checkout: RzpCheckout) {
    const ok = await loadRazorpayCheckout();
    if (!ok) {
      setError("Could not load Razorpay Checkout. Check your connection and retry.");
      return;
    }
    const w = window as unknown as { Razorpay: new (opts: Record<string, unknown>) => { open: () => void } };
    const rzp = new w.Razorpay({
      key: checkout.key_id,
      order_id: checkout.order_id,
      customer_id: checkout.customer_id,
      recurring: 1,
      name: "iTarang",
      description: "E-NACH mandate authorisation",
      prefill: {
        name: checkout.name ?? undefined,
        email: checkout.email ?? undefined,
        contact: checkout.contact ?? undefined,
      },
      // The webhook is the source of truth; these just refresh the panel.
      handler: () => {
        void load();
      },
      modal: {
        ondismiss: () => {
          void load();
        },
      },
    });
    rzp.open();
  }

  async function post(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/enach/${leadId}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : "{}",
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        handoff?: { method?: string; redirect_url?: string; checkout?: RzpCheckout };
      };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      // Managed Razorpay → open Checkout for the customer to authorise.
      if (j.handoff?.method === "itarang_razorpay" && j.handoff.checkout) {
        await openRazorpayCheckout(j.handoff.checkout);
      }
      // Redirect handoff → open the NBFC's deep-link in a new tab.
      if (j.handoff?.redirect_url) window.open(j.handoff.redirect_url, "_blank", "noopener");
      setShowWaive(false);
      setWaiveReason("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const gate = data?.gate;
  const attempts = data?.attempts ?? [];
  const latest = attempts[0];

  if (data && !data.ok) {
    return <p className="text-xs text-slate-500">{data.error ?? "Unavailable."}</p>;
  }
  if (gate && !gate.required) {
    return (
      <div className="rounded-lg border border-slate-200 p-3">
        <p className="text-sm font-semibold text-slate-700">E-NACH</p>
        <p className="text-[11px] text-slate-500 mt-1">{gate.reason}</p>
      </div>
    );
  }

  const status = latest?.status ?? "pending";
  const canAct = data?.can_act ?? false;
  const canWaive = data?.can_waive ?? false;
  const terminalGood = status === "registered" || status === "skipped";

  return (
    <div className="rounded-lg border border-slate-200 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-800">E-NACH (winner only)</span>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${BADGE[status] ?? "bg-slate-100 text-slate-500"}`}>
          {status.replace(/_/g, " ")}
        </span>
      </div>

      {latest?.stale_risk && (
        <p className="text-[11px] text-amber-700 font-semibold">⚠ Stale risk — mandate unpresented &gt; 90 days.</p>
      )}

      <p className="text-[11px] text-slate-500">
        {data?.attempt_count ?? 0} attempt{(data?.attempt_count ?? 0) === 1 ? "" : "s"}
        {latest?.umrn ? ` · UMRN ${latest.umrn}` : ""}
        {latest?.failure_reason ? ` · ${latest.failure_reason}` : ""}
        {latest?.skip_reason ? ` · Waived: ${latest.skip_reason}` : ""}
      </p>

      {error && <p className="text-[11px] text-red-600">{error}</p>}

      {!terminalGood && (
        <div className="flex flex-wrap gap-2">
          {canAct && (
            <button
              onClick={() => post("/register")}
              disabled={busy}
              className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50"
            >
              {latest ? "Retry register" : "Register mandate"}
            </button>
          )}
          {canAct && (
            <button
              onClick={() => post("/record-manual", { status: "registered" })}
              disabled={busy}
              className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-xs font-semibold disabled:opacity-50"
            >
              Record as registered
            </button>
          )}
          {canWaive && (
            <button
              onClick={() => setShowWaive((s) => !s)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md border border-amber-300 text-amber-700 text-xs font-semibold disabled:opacity-50"
            >
              Mark Not Required
            </button>
          )}
        </div>
      )}

      {showWaive && (
        <div className="space-y-2">
          <textarea
            value={waiveReason}
            onChange={(e) => setWaiveReason(e.target.value)}
            rows={2}
            placeholder="Reason for waiving E-NACH (Credit/Underwriting only)…"
            className="w-full text-xs border border-slate-200 rounded-md px-2 py-1.5"
          />
          <button
            onClick={() => waiveReason.trim().length >= 3 && post("/waive", { reason: waiveReason.trim() })}
            disabled={busy || waiveReason.trim().length < 3}
            className="px-3 py-1.5 rounded-md bg-amber-600 text-white text-xs font-semibold disabled:opacity-50"
          >
            Confirm waiver
          </button>
        </div>
      )}
    </div>
  );
}
