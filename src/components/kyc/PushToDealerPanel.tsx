"use client";

// ID 33: "Push to dealer" on the CRM customer file (/admin/kyc-review/[leadId]).
// Admin or Sales Head picks an approved, active dealer (search by name or
// mobile) and gives a reason; the file moves to that dealer, who gets a
// WhatsApp. The button shows only while the API says the push is allowed —
// a house-dealer file with no signed consent, or (admin only) a file that was
// pushed before. The push history is listed underneath when there is any.
// Renders nothing for roles the API refuses (403).
//
// variant "button": a compact row action for lists (WhatsApp Customer leads).
// The list decides visibility from its own `pushable` flag; the state is
// loaded on click and the same dialog opens (or the refusal is shown).

import { useCallback, useEffect, useState } from "react";
import { History, Search, Send, X } from "lucide-react";
import { toast } from "sonner";

interface DealerOption {
  dealerId: string;
  name: string;
  financeEnabled: boolean;
}

interface HistoryRow {
  at: string;
  fromDealerName: string | null;
  toDealerName: string | null;
  byName: string | null;
  byRole?: string | null;
  reason: string | null;
  via: string | null;
  couponReleased?: string | null;
  salespersonCleared?: string | null;
}

interface PushState {
  canPush: boolean;
  blockedReason: string | null;
  isHouse: boolean;
  consentSigned: boolean;
  pushedBefore: boolean;
  needsLoan: boolean;
  currentDealer: { dealerId: string; name: string | null } | null;
  history: HistoryRow[];
}

const VIA_LABEL: Record<string, string> = {
  crm_push: "CRM",
  bulk_dealer_mobile: "Lead list",
  step1_dealer_mobile: "New lead Step 1",
  whatsapp_operator: "WhatsApp",
};

// ID 182: who pushed — a "dealer" role here is an iTarang house login.
const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  sales_head: "Sales Head",
  dealer: "iTarang team",
};

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function PushToDealerPanel({
  leadId,
  variant = "card",
  onPushed,
}: {
  leadId: string;
  variant?: "card" | "button";
  onPushed?: () => void;
}) {
  const [state, setState] = useState<PushState | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<DealerOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<DealerOption | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const [opening, setOpening] = useState(false);

  const load = useCallback(async (): Promise<PushState | null> => {
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/push-to-dealer`, { cache: "no-store" });
      const j = await res.json().catch(() => null);
      const next = j?.success ? (j.data as PushState) : null;
      setState(next);
      return next;
    } catch {
      setState(null);
      return null;
    }
  }, [leadId]);

  useEffect(() => {
    if (variant === "card") load();
  }, [load, variant]);

  // variant "button": fetch the live state, then open the dialog or say why not.
  const openFromButton = async () => {
    setOpening(true);
    try {
      const s = await load();
      if (!s) toast.error("Could not load this file");
      else if (!s.canPush) toast.error(s.blockedReason || "This file can't be pushed");
      else setOpen(true);
    } finally {
      setOpening(false);
    }
  };

  // Debounced dealer search (name or mobile).
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setOptions([]);
      return;
    }
    let alive = true;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        // A customer who needs a loan: finance-enabled dealers only.
        const finance = state?.needsLoan ? "&finance=1" : "";
        const r = await fetch(`/api/leads/dealer-lookup?q=${encodeURIComponent(q)}${finance}`, { cache: "no-store" });
        const j = await r.json().catch(() => null);
        if (alive) setOptions(j?.success ? (j.data?.dealers ?? []) : []);
      } catch {
        if (alive) setOptions([]);
      } finally {
        if (alive) setSearching(false);
      }
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, open, state?.needsLoan]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setOptions([]);
    setPicked(null);
    setReason("");
  };

  const submit = async () => {
    if (!picked || reason.trim().length < 3) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/push-to-dealer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealer_id: picked.dealerId, reason: reason.trim() }),
      });
      const j = await res.json().catch(() => null);
      if (!j?.success) {
        toast.error(j?.error?.message || "Could not push the file");
        return;
      }
      toast.success(`File pushed to ${j.data?.dealer?.name ?? picked.name}`);
      close();
      await load();
      onPushed?.();
    } catch {
      toast.error("Could not push the file");
    } finally {
      setSaving(false);
    }
  };

  function renderDialog(state: PushState) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-900">
              {state.isHouse ? "Push to dealer" : "Move to another dealer"}
            </h3>
            <button type="button" onClick={close} className="text-gray-400 hover:text-gray-600" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          <label className="mb-1 block text-xs font-medium text-gray-600">Dealer (name or mobile)</label>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
            <input
              value={picked ? picked.name : query}
              onChange={(e) => {
                setPicked(null);
                setQuery(e.target.value);
              }}
              placeholder="Type at least 2 letters or a 10-digit mobile"
              className="w-full rounded-lg border border-gray-300 py-2 pl-8 pr-3 text-sm focus:border-[#0047AB] focus:outline-none"
            />
          </div>
          {!picked && query.trim().length >= 2 && (
            <div className="mt-1 max-h-52 overflow-y-auto rounded-lg border border-gray-200">
              {searching ? (
                <div className="px-3 py-2 text-sm text-gray-500">Searching…</div>
              ) : options.length === 0 ? (
                <div className="px-3 py-2 text-sm text-gray-500">No active dealer found</div>
              ) : (
                options.map((o) => (
                  <button
                    key={o.dealerId}
                    type="button"
                    onClick={() => setPicked(o)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50"
                  >
                    <span>{o.name}</span>
                    <span className={`text-xs ${o.financeEnabled ? "text-green-600" : "text-gray-400"}`}>
                      {o.financeEnabled ? "Finance" : "Cash only"}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
          {financeBlocked && (
            <p className="mt-1 text-xs text-red-600">
              This customer needs a loan; {picked!.name} is not enabled for finance leads.
            </p>
          )}

          <label className="mb-1 mt-3 block text-xs font-medium text-gray-600">Reason</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Why is this file going to this dealer?"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#0047AB] focus:outline-none"
          />
          <p className="mt-1 text-xs text-gray-500">
            Any coupon reserved on this file goes back to the current dealer, and their salesperson is cleared — the new dealer assigns their own.
            {state.isHouse ? " A file can be pushed once; moving it again needs an admin." : ""}
          </p>

          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={close} className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700">
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!picked || reason.trim().length < 3 || financeBlocked || saving}
              className="rounded-lg bg-[#0047AB] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? "Pushing…" : "Push"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const financeBlocked = !!picked && !!state?.needsLoan && !picked.financeEnabled;

  if (variant === "button") {
    return (
      <>
        <button
          type="button"
          onClick={openFromButton}
          disabled={opening}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" />
          {opening ? "Checking…" : "Push to dealer"}
        </button>
        {open && state && renderDialog(state)}
      </>
    );
  }

  if (!state) return null;
  const showHistory = state.history.length > 0;
  if (!state.canPush && !showHistory) return null;

  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-gray-700">
          <span className="font-semibold text-gray-900">Dealer:</span>{" "}
          {state.currentDealer?.name ?? "—"}
          {state.isHouse && <span className="ml-2 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">iTarang house</span>}
          {state.consentSigned && (
            <span className="ml-2 rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700">Consent signed — file can&apos;t be moved</span>
          )}
        </div>
        {state.canPush && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-[#0047AB] px-3 py-2 text-sm font-medium text-white hover:bg-[#003a8c]"
          >
            <Send className="h-4 w-4" />
            {state.isHouse ? "Push to dealer" : "Move to another dealer"}
          </button>
        )}
      </div>

      {showHistory && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
            <History className="h-3.5 w-3.5" /> Push history
          </div>
          <ul className="space-y-1.5 text-sm text-gray-700">
            {state.history.map((h, i) => (
              <li key={i}>
                <span className="text-gray-500">{fmtWhen(h.at)}</span> · {h.fromDealerName ?? "—"} → <b>{h.toDealerName ?? "—"}</b>
                {h.byName ? ` · by ${h.byName}` : ""}
                {h.byRole ? ` (${ROLE_LABEL[h.byRole] ?? h.byRole})` : ""}
                {h.via ? ` · ${VIA_LABEL[h.via] ?? h.via}` : ""}
                {h.reason ? <span className="block pl-4 text-xs text-gray-500">Reason: {h.reason}</span> : null}
                {h.couponReleased || h.salespersonCleared ? (
                  <span className="block pl-4 text-xs text-gray-500">
                    {[
                      h.couponReleased ? `Coupon ${h.couponReleased} released to the previous dealer` : null,
                      h.salespersonCleared ? `Salesperson ${h.salespersonCleared} cleared` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {open && renderDialog(state)}
    </div>
  );
}
