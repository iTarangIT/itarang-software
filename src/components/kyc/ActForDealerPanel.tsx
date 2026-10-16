"use client";

// ID 183 — "Act for dealer" on the CRM customer file (/admin/kyc-review/[leadId])
// for Admin and Sales Head. Every step is the dealer's own route run as the
// FILE's dealer (consent name, lender pins, coupon pool), recorded "Done by
// <name> for <dealer>", and the dealer is told (bell + WhatsApp).
//
//   Phase 1: documents (with "uploaded by"), the consent code (send + enter,
//            with who sent / entered each), coupon, submit for verification.
//   Phase 2: loan amount asked, lender pick, offers + pick the winner, lender
//            document questions, another lender, switch to cash, close.
//   Never:   Step 5 (dispatch), cash sale, delivered — the dealer's alone.
//
// May act: house-pushed files any time; the dealer's own files after 1 working
// day with no dealer action, or while the dealer asked for help. While one
// person works the file it shows "being worked by <name>" for 30 minutes; the
// dealer's own action always wins (each step sends the dealer's last action
// the panel saw; a newer one refuses the step and the panel reloads).
// Renders nothing for roles the API refuses (403).

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Handshake, History, Lock, RefreshCw } from "lucide-react";

interface ActState {
  lead: {
    id: string;
    referenceId: string | null;
    customerName: string;
    kycStatus: string | null;
    stage: string;
    paymentMethod: string | null;
    couponCode: string | null;
    couponStatus: string | null;
    consentStatus: string | null;
  };
  dealer: { dealerId: string | null; name: string | null };
  me: { userId: string; name: string | null };
  permission: { ok: true; ground: string } | { ok: false; message: string };
  housePushed: boolean;
  dealerAsked: boolean;
  dealerLastActionAt: string | null;
  lock: { holderName: string | null; expiresAt: string; mine: boolean } | null;
  lockMinutes: number;
  seenHeader: string;
  documents: Array<{ id: string; docType: string; docFor: string; fileName: string | null; status: string | null; uploadedAt: string | null; uploadedBy: string | null }>;
  consentCodes: Array<{ id: string; consentFor: string; sentAt: string; sentBy: string | null; sendCount: number; channel: string | null; live: boolean; expiresAt: string; verifiedAt: string | null; enteredBy: string | null }>;
  history: Array<{ at: string; line: string; step: string | null }>;
}

interface LenderProduct { id: number; productName: string; minRoiPct: string; maxRoiPct: string; tenureMonthsMin: number; tenureMonthsMax: number }
interface Lender { nbfcId: number; shortName: string; legalName: string; activeLoanProducts: LenderProduct[] }
interface OfferItem { nbfc_id: number; nbfc_short_name: string | null; status: string; offer: { loan_amount: string | null; roi_pct: string | null; tenure_months: number | null; emi_amount: string | null } | null }
interface DocRequest { id: string; nbfcName: string; status: string; messages: Array<{ id: string; party: string; message: string | null }> }

const DOC_TYPES: Array<[string, string]> = [
  ["aadhaar_front", "Aadhaar front"],
  ["aadhaar_back", "Aadhaar back"],
  ["pan_card", "PAN card"],
  ["passport_photo", "Passport photo"],
  ["rc_copy", "RC copy"],
  ["address_proof", "Address proof"],
  ["bank_statement", "Bank statement"],
  ["cheque_1", "Cheque 1"],
  ["cheque_2", "Cheque 2"],
  ["cheque_3", "Cheque 3"],
  ["cheque_4", "Cheque 4"],
];

const GROUND: Record<string, string> = {
  house_pushed: "iTarang pushed this file — you may act any time.",
  dealer_asked: "The dealer asked iTarang to help on this file.",
  dealer_idle: "No dealer action for over 1 working day.",
};

function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" });
}

const label = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export default function ActForDealerPanel({ leadId }: { leadId: string }) {
  const [state, setState] = useState<ActState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Phase 1 inputs
  const [docType, setDocType] = useState(DOC_TYPES[0][0]);
  const [docFor, setDocFor] = useState<"customer" | "borrower">("customer");
  const [file, setFile] = useState<File | null>(null);
  const [channel, setChannel] = useState("call");
  const [consentFor, setConsentFor] = useState<"customer" | "borrower">("customer");
  const [otp, setOtp] = useState("");
  const [coupon, setCoupon] = useState("");

  // Phase 2 data + inputs
  const [lenders, setLenders] = useState<Lender[] | null>(null);
  const [pick, setPick] = useState<string>("");
  const [offers, setOffers] = useState<OfferItem[] | null>(null);
  const [requests, setRequests] = useState<DocRequest[] | null>(null);
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [loanAmount, setLoanAmount] = useState("");

  const base = `/api/lead/${encodeURIComponent(leadId)}`;
  const kyc = `/api/kyc/${encodeURIComponent(leadId)}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/act-for-dealer`, { cache: "no-store" });
      if (res.status === 403) return setHidden(true);
      const json = await res.json();
      if (json.success) setState(json.data);
    } catch {
      /* the panel stays as it was */
    }
  }, [leadId]);

  const loadPhase2 = useCallback(async () => {
    const get = async (url: string) => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    };
    const [g, o, n, a] = await Promise.all([
      get(`${base}/section-g-options`),
      get(`${base}/offers`),
      get(`${base}/nbfc-requests`),
      get(`${base}/requested-loan-amount`),
    ]);
    setLenders(g?.success ? g.data.items : []);
    setOffers(o?.success ? o.data.items : []);
    setRequests(n?.ok ? n.requests : []);
    if (a?.success && a.data.amount != null) setLoanAmount(String(a.data.amount));
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (open) void loadPhase2();
  }, [open, loadPhase2]);

  const seen = useMemo(() => state?.dealerLastActionAt ?? "none", [state]);

  /** Run one step; on any refusal show it and reload (dealer may have acted). */
  async function step(key: string, url: string, init: RequestInit, done: string): Promise<boolean> {
    if (!state) return false;
    setBusy(key);
    try {
      const headers = new Headers(init.headers);
      headers.set(state.seenHeader, seen);
      const res = await fetch(url, { ...init, headers });
      const json = await res.json().catch(() => null);
      const ok = res.ok && (json?.success === true || json?.ok === true || json?.valid === true);
      if (!ok) {
        toast.error(json?.error?.message || json?.error || json?.message || "That step was refused");
        return false;
      }
      toast.success(done);
      if (json?.data?._devOtp) toast.message(`Test code: ${json.data._devOtp}`);
      return true;
    } catch {
      toast.error("Network error — try again");
      return false;
    } finally {
      setBusy(null);
      await load();
      if (open) await loadPhase2();
    }
  }

  if (hidden || !state) return null;
  const canAct = state.permission.ok && !(state.lock && !state.lock.mine);
  const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const lenderOptions = (lenders ?? []).flatMap((l) =>
    l.activeLoanProducts.map((p) => ({ key: `${l.nbfcId}:${p.id}`, nbfcId: l.nbfcId, productId: p.id, text: `${l.shortName} — ${p.productName} (${p.minRoiPct}–${p.maxRoiPct}% · ${p.tenureMonthsMin}–${p.tenureMonthsMax} mo)` })),
  );
  const picked = lenderOptions.find((o) => o.key === pick);

  return (
    <div className="mb-4 rounded-xl border border-indigo-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-gray-700">
          <div className="flex items-center gap-2 font-semibold text-gray-900">
            <Handshake className="h-4 w-4 text-indigo-600" /> Act for dealer — {state.dealer.name ?? "—"}
          </div>
          <div className="mt-1 text-xs text-gray-600">
            {state.permission.ok ? GROUND[state.permission.ground] ?? "You may act for the dealer." : state.permission.message}
            {state.dealerAsked && state.permission.ok && state.permission.ground !== "dealer_asked" ? " The dealer has also asked for help." : ""}
          </div>
          {state.lock && (
            <div className={`mt-1 flex items-center gap-1 text-xs ${state.lock.mine ? "text-indigo-700" : "text-amber-700"}`}>
              <Lock className="h-3 w-3" />
              {state.lock.mine ? "You are working this file" : `Being worked by ${state.lock.holderName ?? "someone from iTarang"}`} until {when(state.lock.expiresAt)}
            </div>
          )}
          <div className="mt-1 text-xs text-gray-500">
            Dealer&apos;s last action: {when(state.dealerLastActionAt)} · Stage: {state.lead.stage}. Dispatch (Step 5), the cash sale and
            &quot;delivered&quot; stay with the dealer.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void load()} className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs text-gray-600" title="Reload">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => setOpen((v) => !v)} className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700">
            {open ? "Close" : "Act for dealer"}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-4 space-y-5 border-t border-gray-100 pt-4 text-sm">
          {!canAct && <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">You can look, but every step will be refused until the reason above clears.</p>}

          {/* Phase 1 — documents */}
          <section>
            <h3 className="mb-2 font-semibold text-gray-900">Documents</h3>
            <ul className="mb-2 space-y-1 text-xs text-gray-700">
              {state.documents.length === 0 && <li className="text-gray-500">No documents yet.</li>}
              {state.documents.map((d) => (
                <li key={d.id}>
                  {label(d.docType)}
                  {d.docFor === "borrower" ? " (co-borrower)" : ""} · {d.status ?? "—"} · uploaded {when(d.uploadedAt)}
                  {d.uploadedBy ? ` by ${d.uploadedBy}` : ""}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <select className="rounded border border-gray-300 px-2 py-1.5" value={docType} onChange={(e) => setDocType(e.target.value)}>
                {DOC_TYPES.map(([v, t]) => (
                  <option key={v} value={v}>{t}</option>
                ))}
              </select>
              <select className="rounded border border-gray-300 px-2 py-1.5" value={docFor} onChange={(e) => setDocFor(e.target.value as "customer" | "borrower")}>
                <option value="customer">Customer</option>
                <option value="borrower">Co-borrower</option>
              </select>
              <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-xs" />
              <button
                type="button"
                disabled={!file || !!busy}
                className="rounded bg-gray-900 px-3 py-1.5 text-white disabled:opacity-50"
                onClick={async () => {
                  if (!file) return;
                  const fd = new FormData();
                  fd.append("file", file);
                  fd.append("docType", docType);
                  fd.append("docFor", docFor);
                  if (await step("upload", `${kyc}/upload-document`, { method: "POST", body: fd }, "Document uploaded")) setFile(null);
                }}
              >
                {busy === "upload" ? "Uploading…" : "Upload"}
              </button>
            </div>
          </section>

          {/* Phase 1 — consent code */}
          <section>
            <h3 className="mb-2 font-semibold text-gray-900">Consent code</h3>
            <p className="mb-2 text-xs text-gray-600">Consent status: {state.lead.consentStatus ?? "—"}. One live code at a time; the consent form names {state.dealer.name ?? "the dealer"}.</p>
            <div className="flex flex-wrap items-center gap-2">
              <select className="rounded border border-gray-300 px-2 py-1.5" value={consentFor} onChange={(e) => setConsentFor(e.target.value as "customer" | "borrower")}>
                <option value="customer">Customer</option>
                <option value="borrower">Co-borrower</option>
              </select>
              <select className="rounded border border-gray-300 px-2 py-1.5" value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="call">Voice call</option>
                <option value="sms">SMS</option>
                <option value="whatsapp">WhatsApp</option>
              </select>
              <button type="button" disabled={!!busy} className="rounded bg-gray-900 px-3 py-1.5 text-white disabled:opacity-50"
                onClick={() => void step("send", `${kyc}/send-consent`, json({ channel, consent_for: consentFor, method: "otp" }), "Consent code sent")}>
                {busy === "send" ? "Sending…" : "Send code"}
              </button>
              <input className="w-28 rounded border border-gray-300 px-2 py-1.5" placeholder="6-digit code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} />
              <button type="button" disabled={otp.length !== 6 || !!busy} className="rounded bg-gray-900 px-3 py-1.5 text-white disabled:opacity-50"
                onClick={async () => {
                  if (await step("verify", `${kyc}/verify-consent-otp`, json({ otp, consent_for: consentFor }), "Consent verified")) setOtp("");
                }}>
                {busy === "verify" ? "Checking…" : "Enter code"}
              </button>
            </div>
            <ul className="mt-2 space-y-1 text-xs text-gray-700">
              {state.consentCodes.map((c) => (
                <li key={c.id}>
                  {c.consentFor === "co_borrower" ? "Co-borrower" : "Customer"} · sent {when(c.sentAt)}{c.sentBy ? ` by ${c.sentBy}` : ""} ({c.channel ?? "—"}, {c.sendCount}×)
                  {c.verifiedAt ? ` · entered ${when(c.verifiedAt)}${c.enteredBy ? ` by ${c.enteredBy}` : ""}` : c.live ? ` · live until ${when(c.expiresAt)}` : " · not used"}
                </li>
              ))}
            </ul>
          </section>

          {/* Phase 1 — coupon + submit */}
          <section>
            <h3 className="mb-2 font-semibold text-gray-900">Coupon and submit</h3>
            <p className="mb-2 text-xs text-gray-600">
              Coupon on file: {state.lead.couponCode ?? "none"} ({state.lead.couponStatus ?? "—"}). Use a coupon from {state.dealer.name ?? "the dealer"}&apos;s pool.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input className="w-40 rounded border border-gray-300 px-2 py-1.5" placeholder="Coupon code" value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} />
              <button type="button" disabled={!coupon || !!busy} className="rounded bg-gray-900 px-3 py-1.5 text-white disabled:opacity-50"
                onClick={() => void step("coupon", `${kyc}/validate-coupon`, json({ couponCode: coupon }), "Coupon applied")}>
                Apply coupon
              </button>
              <button type="button" disabled={!!busy} className="rounded bg-indigo-600 px-3 py-1.5 text-white disabled:opacity-50"
                onClick={() => void step("submit", `${kyc}/submit-verification`, json({ verification_for: "customer" }), "Submitted for verification")}>
                {busy === "submit" ? "Submitting…" : "Submit for verification"}
              </button>
            </div>
          </section>

          {/* Phase 2 — lender journey */}
          <section className="border-t border-gray-100 pt-4">
            <h3 className="mb-2 font-semibold text-gray-900">Lender (Step 4)</h3>
            <div className="flex flex-wrap items-center gap-2">
              <input className="w-36 rounded border border-gray-300 px-2 py-1.5" placeholder="Loan amount (₹)" value={loanAmount} onChange={(e) => setLoanAmount(e.target.value.replace(/\D/g, ""))} />
              <button type="button" disabled={!loanAmount || !!busy} className="rounded border border-gray-300 px-3 py-1.5 disabled:opacity-50"
                onClick={() => void step("amount", `${base}/requested-loan-amount`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: Number(loanAmount) }) }, "Loan amount saved")}>
                Save amount
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select className="min-w-[320px] rounded border border-gray-300 px-2 py-1.5" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">{lenders === null ? "Loading lenders…" : lenderOptions.length ? "Pick the lender" : "No lender matches this file"}</option>
                {lenderOptions.map((o) => (
                  <option key={o.key} value={o.key}>{o.text}</option>
                ))}
              </select>
              <button type="button" disabled={!picked || !!busy} className="rounded bg-gray-900 px-3 py-1.5 text-white disabled:opacity-50"
                onClick={() => picked && void step("lender", `${base}/submit-product-selection`, json({ selectedNbfcs: [{ nbfc_id: String(picked.nbfcId), loan_product_id: picked.productId }], customerDisclosureAck: true }), "Sent to the lender")}>
                Send to lender
              </button>
              <button type="button" disabled={!picked || !!busy} className="rounded border border-gray-300 px-3 py-1.5 disabled:opacity-50"
                onClick={() => picked && void step("reselect", `${base}/reselect-financing`, json({ nbfcId: picked.nbfcId, loanProductId: picked.productId }), "Sent to another lender")}>
                Another lender (after a rejection)
              </button>
            </div>
          </section>

          <section>
            <h3 className="mb-2 font-semibold text-gray-900">Offers</h3>
            {(offers ?? []).length === 0 && <p className="text-xs text-gray-500">No lender offers yet.</p>}
            <ul className="space-y-1 text-xs text-gray-700">
              {(offers ?? []).map((o) => (
                <li key={o.nbfc_id} className="flex flex-wrap items-center gap-2">
                  <span>
                    {o.nbfc_short_name ?? o.nbfc_id} · {o.status}
                    {o.offer ? ` · ₹${o.offer.loan_amount ?? "—"} at ${o.offer.roi_pct ?? "—"}% for ${o.offer.tenure_months ?? "—"} mo (EMI ₹${o.offer.emi_amount ?? "—"})` : ""}
                  </span>
                  {o.offer && (
                    <button type="button" disabled={!!busy} className="rounded border border-gray-300 px-2 py-1 disabled:opacity-50"
                      onClick={() => void step("winner", `${base}/select-winner`, json({ nbfcId: o.nbfc_id }), "Offer picked")}>
                      Pick this offer
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-2 font-semibold text-gray-900">Lender questions</h3>
            {(requests ?? []).length === 0 && <p className="text-xs text-gray-500">No open lender questions.</p>}
            {(requests ?? []).map((r) => (
              <div key={r.id} className="mb-2 rounded border border-gray-100 p-2 text-xs">
                <div className="font-medium">{r.nbfcName} · {r.status}</div>
                {r.messages.map((m) => (
                  <div key={m.id} className="text-gray-600">{m.party}: {m.message ?? "(files)"}</div>
                ))}
                <div className="mt-1 flex gap-2">
                  <input className="flex-1 rounded border border-gray-300 px-2 py-1" placeholder="Reply" value={replyText[r.id] ?? ""} onChange={(e) => setReplyText((p) => ({ ...p, [r.id]: e.target.value }))} />
                  <button type="button" disabled={!(replyText[r.id] ?? "").trim() || !!busy} className="rounded bg-gray-900 px-2 py-1 text-white disabled:opacity-50"
                    onClick={async () => {
                      if (await step(`reply-${r.id}`, `${base}/nbfc-requests/${encodeURIComponent(r.id)}/reply`, json({ message: replyText[r.id] }), "Reply sent")) setReplyText((p) => ({ ...p, [r.id]: "" }));
                    }}>
                    Reply
                  </button>
                </div>
              </div>
            ))}
          </section>

          <section className="flex flex-wrap gap-2">
            <button type="button" disabled={!!busy} className="rounded border border-amber-300 px-3 py-1.5 text-amber-800 disabled:opacity-50"
              onClick={() => window.confirm("Switch this file to a cash sale? Finance data on the file is removed.") && void step("cash", `${base}/switch-to-cash`, json({}), "Switched to cash")}>
              Switch to cash
            </button>
            <button type="button" disabled={!!busy} className="rounded border border-red-300 px-3 py-1.5 text-red-700 disabled:opacity-50"
              onClick={() => window.confirm("Close this file (loan rejected)?") && void step("close", `${base}/close-lead`, json({}), "File closed")}>
              Close file (loan rejected)
            </button>
          </section>

          <section className="border-t border-gray-100 pt-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
              <History className="h-3.5 w-3.5" /> Done for the dealer
            </div>
            {state.history.length === 0 && <p className="text-xs text-gray-500">Nothing yet.</p>}
            <ul className="space-y-1 text-xs text-gray-700">
              {state.history.map((h, i) => (
                <li key={i}>
                  <span className="text-gray-500">{when(h.at)}</span> · {h.line}{h.step ? `: ${h.step}` : ""}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
