"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  Banknote,
  Battery,
  Plug,
  Package,
  Clock,
  Lock,
  ArrowRight,
  Loader2,
  Phone,
} from "lucide-react";

// BRD V2 Part F — Step 5 OTP + Dispatch Confirmation (finance only).
// Scenario A: kyc_status = loan_sanctioned → loan panel + OTP send/entry + dispatch.
// Scenario B: kyc_status = loan_rejected → rejection banner + follow-up actions.
// Cash leads complete at Step 4 — they never reach this page.

interface LoanSanction {
  id: string;
  status: string;
  loan_amount: string | null;
  down_payment: string | null;
  file_charge: string | null;
  subvention: string | null;
  disbursement_amount: string | null;
  emi: string | null;
  tenure_months: number | null;
  roi: string | null;
  loan_approved_by: string | null;
  loan_file_number: string | null;
  rejection_reason: string | null;
  sanctioned_at: string | null;
  decided_at: string | null;
}

interface ProductSelection {
  battery_serial: string | null;
  charger_serial: string | null;
  paraphernalia: Record<string, unknown> | null;
  dealer_margin: string | null;
  final_price: string | null;
  category?: string | null;
  sub_category?: string | null;
}

interface OtpState {
  id: string;
  sendCount: number;
  attemptCount: number;
  maxSends: number;
  expiresAt: string;
  lockedUntil: string | null;
  isUsed: boolean;
}

interface DispatchInfo {
  warrantyId: string;
  warrantyEnd: string | null;
  dispatchDate: string | null;
  autoSoldAt: string | null;
}

interface StatusData {
  leadStatus: string;
  scenario: "loan_sanctioned" | "loan_rejected" | "dispatched" | null;
  paymentMethod: string | null;
  phone: string | null;
  productSelection: ProductSelection | null;
  loanSanction: LoanSanction | null;
  otp: OtpState | null;
  dispatch: DispatchInfo | null;
}

interface AccessData {
  allowed: boolean;
  scenario?: "loan_sanctioned" | "loan_rejected" | "dispatched";
  redirectTo?: string;
  reason?: string;
}

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

function fmtINR(value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return inrFormatter.format(n);
}

function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function Step5Page() {
  const params = useParams();
  const router = useRouter();
  const leadId = params.id as string;

  const [data, setData] = useState<StatusData | null>(null);
  const [access, setAccess] = useState<AccessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [otpSentTo, setOtpSentTo] = useState<string | null>(null);
  const [otpDigits, setOtpDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState<null | { warrantyId: string }>(null);
  // Dev / no-provider mode: API echoes back the OTP so the tester can read
  // it without an SMS provider. Null in production once MSG91 is live.
  const [devOtp, setDevOtp] = useState<string | null>(null);

  const [actioning, setActioning] = useState<null | "close" | "switch">(null);

  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  const load = async () => {
    try {
      const [accessRes, statusRes] = await Promise.all([
        fetch(`/api/lead/${leadId}/step-5-access`).then((r) => r.json()),
        fetch(`/api/lead/${leadId}/step-5/status`).then((r) => r.json()),
      ]);

      if (accessRes?.success) {
        setAccess(accessRes.data);
      } else {
        setError(accessRes?.error?.message || "Access check failed");
      }

      if (statusRes?.success) {
        setData(statusRes.data);
        if (statusRes.data?.otp?.expiresAt && !statusRes.data.otp.isUsed) {
          const ms = new Date(statusRes.data.otp.expiresAt).getTime() - Date.now();
          setSecondsLeft(Math.max(0, Math.floor(ms / 1000)));
        }
      } else {
        setError(statusRes?.error?.message || "Failed to load");
      }
    } catch {
      setError("Failed to load Step 5 state");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  // Redirect when access gate says we shouldn't be here.
  useEffect(() => {
    if (access && !access.allowed && access.redirectTo) {
      const t = setTimeout(() => router.push(access.redirectTo!), 1800);
      return () => clearTimeout(t);
    }
  }, [access, router]);

  // OTP countdown
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [secondsLeft]);

  const handleSendOtp = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/lead/${leadId}/step-5/send-otp`, { method: "POST" });
      const json = await res.json();
      if (json.success) {
        setOtpSentTo(json.data.otpSentTo);
        setSecondsLeft(json.data.expiresInSeconds || 600);
        setOtpDigits(["", "", "", "", "", ""]);
        // Dev / hardcoded path: surface OTP so the tester can use it.
        setDevOtp(json.data._devOtp ?? null);
        await load();
        inputsRef.current[0]?.focus();
      } else {
        setError(json.error?.message || "Failed to send OTP");
      }
    } catch {
      setError("Failed to send OTP");
    } finally {
      setSending(false);
    }
  };

  const handleOtpChange = (i: number, v: string) => {
    const digit = v.replace(/\D/g, "").slice(-1);
    setOtpDigits((prev) => {
      const next = [...prev];
      next[i] = digit;
      return next;
    });
    if (digit && i < 5) inputsRef.current[i + 1]?.focus();
  };

  const handleOtpKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !otpDigits[i] && i > 0) {
      inputsRef.current[i - 1]?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 6) {
      e.preventDefault();
      setOtpDigits(pasted.split(""));
      inputsRef.current[5]?.focus();
    }
  };

  const handleConfirm = async () => {
    const otp = otpDigits.join("");
    if (otp.length !== 6) {
      setError("Enter all 6 digits");
      return;
    }
    setConfirming(true);
    setError(null);
    try {
      const res = await fetch(`/api/lead/${leadId}/step-5/confirm-dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otp }),
      });
      const json = await res.json();
      if (json.success) {
        // BRD §3.5: lead is now in 'dispatched' state, not 'sold'. Reload so
        // the page swaps to the dispatched-scenario panel with Mark Delivered.
        await load();
      } else {
        setError(json.error?.message || "OTP validation failed");
      }
    } catch {
      setError("OTP validation failed");
    } finally {
      setConfirming(false);
    }
  };

  const [marking, setMarking] = useState(false);
  const handleMarkDelivered = async () => {
    if (!confirm("Confirm physical delivery to the customer? This finalizes the sale.")) return;
    setMarking(true);
    setError(null);
    try {
      const res = await fetch(`/api/lead/${leadId}/mark-delivered`, { method: "POST" });
      const json = await res.json();
      if (json.success) {
        setConfirmed({ warrantyId: json.data.warrantyId ?? data?.dispatch?.warrantyId ?? "—" });
      } else {
        setError(json.error?.message || "Failed to mark delivered");
      }
    } catch {
      setError("Failed to mark delivered");
    } finally {
      setMarking(false);
    }
  };

  const handleCloseLead = async () => {
    if (!confirm("Close this lead permanently? This cannot be undone.")) return;
    setActioning("close");
    setError(null);
    try {
      const res = await fetch(`/api/lead/${leadId}/close-lead`, { method: "POST" });
      const json = await res.json();
      if (json.success) {
        router.push("/dealer-portal/leads");
      } else {
        setError(json.error?.message || "Failed to close lead");
      }
    } catch {
      setError("Failed to close lead");
    } finally {
      setActioning(null);
    }
  };

  const handleSwitchToCash = async () => {
    if (
      !confirm(
        "Convert this lead to a CASH sale? The dealer is the sole authoriser — no admin approval. The customer pays the dealer directly.",
      )
    )
      return;
    setActioning("switch");
    setError(null);
    try {
      const res = await fetch(`/api/lead/${leadId}/switch-to-cash`, { method: "POST" });
      const json = await res.json();
      if (json.success) {
        router.push(json.data.redirectTo || `/dealer-portal/leads/${leadId}/product-selection`);
      } else {
        setError(json.error?.message || "Failed to switch payment mode");
      }
    } catch {
      setError("Failed to switch payment mode");
    } finally {
      setActioning(null);
    }
  };

  // ─── Loading / error states ──────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex items-center gap-3 text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Loading Step 5…</span>
        </div>
      </div>
    );
  }

  if (access && !access.allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border border-gray-200 p-8 text-center shadow-sm">
          <Lock className="w-10 h-10 text-amber-500 mx-auto mb-3" />
          <h2 className="text-lg font-bold text-gray-900">Step 5 not available</h2>
          <p className="text-sm text-gray-600 mt-2">
            {access.reason || "This step is not unlocked yet for the current lead."}
          </p>
          {access.redirectTo && (
            <p className="text-xs text-gray-400 mt-4">Redirecting…</p>
          )}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-sm text-red-600">{error || "No data"}</div>
      </div>
    );
  }

  // ─── Confirmed (post-dispatch) success state ─────────────────────────────

  if (confirmed) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-emerald-50 to-white flex items-center justify-center p-6">
        <div className="max-w-xl w-full bg-white rounded-3xl border border-emerald-200 p-10 text-center shadow-lg">
          <div className="w-20 h-20 bg-emerald-100 rounded-full mx-auto mb-5 flex items-center justify-center">
            <CheckCircle2 className="w-12 h-12 text-emerald-600" />
          </div>
          <h2 className="text-2xl font-black text-emerald-900">Dispatch Confirmed</h2>
          <p className="text-sm text-emerald-700 mt-3">
            The customer&apos;s loan terms are accepted, inventory is sold, and the warranty is now
            active.
          </p>
          <div className="mt-6 bg-emerald-50 rounded-xl px-5 py-3 inline-flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-700" />
            <span className="text-xs font-bold text-emerald-700 uppercase tracking-wider">
              Warranty
            </span>
            <span className="font-mono text-sm font-bold text-emerald-900">
              {confirmed.warrantyId}
            </span>
          </div>
          <button
            onClick={() => router.push("/dealer-portal/leads")}
            className="mt-8 px-6 py-2.5 bg-[#0047AB] hover:bg-[#003580] text-white rounded-xl font-bold text-sm transition-colors"
          >
            Back to Leads
          </button>
        </div>
      </div>
    );
  }

  const scenario = data.scenario || access?.scenario || null;

  // ─── Scenario C — Dispatched (post-OTP, awaiting delivery) ──────────────

  if (scenario === "dispatched") {
    const dispatch = data.dispatch;
    const product = data.productSelection;
    const loan = data.loanSanction;
    const dispatchDate = dispatch?.dispatchDate ? new Date(dispatch.dispatchDate) : null;
    const autoSoldAt = dispatch?.autoSoldAt ? new Date(dispatch.autoSoldAt) : null;
    const hoursToAuto = autoSoldAt
      ? Math.max(0, Math.round((autoSoldAt.getTime() - Date.now()) / 3_600_000))
      : null;
    return (
      <div className="min-h-screen bg-gradient-to-b from-emerald-50/50 to-gray-50">
        <div className="max-w-3xl mx-auto p-6 sm:p-8 space-y-5">
          <ProgressHeader leadId={leadId} active={5} />
          <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-2xl font-black text-gray-900">
                Step 5 — Dispatched
              </h1>
              <p className="text-sm text-gray-500 font-mono">{leadId}</p>
            </div>
            <span className="self-start inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-bold uppercase tracking-wider">
              <CheckCircle2 className="w-3 h-3" /> Awaiting Delivery
            </span>
          </header>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <section className="bg-white border-2 border-emerald-200 rounded-2xl p-6 shadow-sm space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center flex-shrink-0">
                <ShieldCheck className="w-5 h-5 text-emerald-600" />
              </div>
              <div className="flex-1">
                <h2 className="font-bold text-emerald-900">
                  OTP accepted — battery dispatched
                </h2>
                <p className="text-xs text-gray-600 mt-1">
                  Inventory is now in <b>dispatched</b> state. The warranty is active and the
                  customer has been notified. Click <b>Mark Delivered</b> when the customer
                  has physically received the unit, or the system will auto-finalize the sale
                  in {hoursToAuto !== null ? `${hoursToAuto} hour${hoursToAuto === 1 ? "" : "s"}` : "1 day"}.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm pt-2 border-t border-emerald-100">
              <KV
                label="Warranty"
                value={
                  <span className="font-mono text-xs">{dispatch?.warrantyId ?? "—"}</span>
                }
              />
              <KV
                label="Warranty Until"
                value={fmtDate(dispatch?.warrantyEnd)}
              />
              <KV label="Battery" value={<span className="font-mono text-xs">{product?.battery_serial ?? "—"}</span>} />
              <KV label="Charger" value={<span className="font-mono text-xs">{product?.charger_serial ?? "—"}</span>} />
              <KV label="Dispatched" value={fmtDateTime(dispatchDate?.toISOString())} />
              <KV label="Auto-finalize" value={fmtDateTime(autoSoldAt?.toISOString())} />
              <KV label="Loan Ref" value={loan?.loan_file_number ?? "—"} />
              <KV label="Lender" value={loan?.loan_approved_by ?? "—"} />
            </div>
          </section>

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={handleMarkDelivered}
              disabled={marking}
              className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-sm transition-colors disabled:opacity-50"
            >
              {marking ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              {marking ? "Finalising…" : "Mark Delivered"}
            </button>
            <button
              onClick={() => router.push("/dealer-portal/leads")}
              className="px-5 py-3 border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-xl font-bold text-sm transition-colors"
            >
              Back to Leads
            </button>
          </div>

          <p className="text-[11px] text-gray-400 text-center pt-2">
            BRD §3.5: dispatched → sold runs daily via cron at 04:00 UTC, or via this button.
          </p>
        </div>
      </div>
    );
  }

  // ─── Scenario B — Loan Rejected ──────────────────────────────────────────

  if (scenario === "loan_rejected") {
    const loan = data.loanSanction;
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-3xl mx-auto p-6 sm:p-8 space-y-5">
          <ProgressHeader leadId={leadId} active={5} />
          <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-2xl font-black text-gray-900">
                Step 5 — Loan Rejected
              </h1>
              <p className="text-sm text-gray-500 font-mono">{leadId}</p>
            </div>
            <span className="self-start inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-100 text-red-800 text-[11px] font-bold uppercase tracking-wider">
              <AlertCircle className="w-3 h-3" /> Loan Rejected
            </span>
          </header>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="bg-white border-2 border-red-200 rounded-2xl p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center flex-shrink-0">
                <AlertCircle className="w-5 h-5 text-red-600" />
              </div>
              <div className="flex-1">
                <h2 className="font-bold text-red-900">Loan Application Rejected</h2>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 mt-3 text-xs">
                  <KV label="Rejected on" value={fmtDate(loan?.decided_at)} />
                  <KV label="By lender" value={loan?.loan_approved_by ?? "—"} />
                </div>
                <div className="mt-4 bg-red-50 border border-red-100 rounded-lg p-3 text-sm text-red-800">
                  <span className="font-bold">Reason: </span>
                  {loan?.rejection_reason || "No reason provided."}
                </div>
                <p className="text-xs text-gray-600 mt-4">
                  Inventory has been released. Battery{" "}
                  <span className="font-mono font-bold">
                    {data.productSelection?.battery_serial ?? "—"}
                  </span>{" "}
                  and Charger{" "}
                  <span className="font-mono font-bold">
                    {data.productSelection?.charger_serial ?? "—"}
                  </span>{" "}
                  are available again.
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
            <h3 className="font-bold text-gray-900 mb-1">Next steps</h3>
            <p className="text-xs text-gray-500 mb-4">Choose how you want to proceed with this customer.</p>
            <div className="grid grid-cols-1 gap-3">
              <ActionRow
                title="Re-apply with Co-Borrower"
                description="Add a co-borrower and re-submit to the lender for KYC + credit check."
                onClick={() =>
                  router.push(`/dealer-portal/leads/${leadId}/borrower-consent`)
                }
                tone="primary"
              />
              <ActionRow
                title="Change Payment Mode to Cash"
                description="Convert to a cash sale. No admin approval — dealer authorises directly."
                onClick={handleSwitchToCash}
                tone="outline"
                busy={actioning === "switch"}
              />
              <ActionRow
                title="Close Lead"
                description="Mark this lead as closed. No further action will be possible."
                onClick={handleCloseLead}
                tone="muted"
                busy={actioning === "close"}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Scenario A — Loan Sanctioned ────────────────────────────────────────

  const loan = data.loanSanction;
  const product = data.productSelection;
  const mm = Math.floor(secondsLeft / 60);
  const ss = secondsLeft % 60;

  const otp = data.otp;
  const sendCount = otp?.sendCount ?? 0;
  const maxSends = otp?.maxSends ?? 3;
  // BRD: Resend available 30s after send; max 3 sends per session, then 30-min cooldown.
  // OTP_LIFETIME = 600s, so secondsLeft > 570 means <30s elapsed since last send.
  const resendCoolingDown = secondsLeft > 570;
  const resendMaxedOut = sendCount >= maxSends;

  const otpSessionActive = !!otp && !otp.isUsed;
  const showOtpUi = otpSessionActive || !!otpSentTo;

  const paraphernaliaItems = formatParaphernalia(product?.paraphernalia);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto p-6 sm:p-8 space-y-5">
        <ProgressHeader leadId={leadId} active={5} />

        <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black text-gray-900">
              Step 5 — Loan Details &amp; Dispatch
            </h1>
            <p className="text-sm text-gray-500 font-mono">{leadId}</p>
          </div>
          <div className="flex flex-col items-start sm:items-end gap-1.5">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-bold uppercase tracking-wider">
              <ShieldCheck className="w-3 h-3" /> Loan Sanctioned · Pending Customer OTP
            </span>
            {loan?.decided_at && (
              <span className="text-[11px] text-gray-500">
                Sanctioned {fmtDateTime(loan.decided_at)}
                {loan.loan_approved_by ? ` · ${loan.loan_approved_by}` : ""}
              </span>
            )}
          </div>
        </header>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* ─── Loan Details Card ─────────────────────────────────────────── */}
        {loan && (
          <section className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
            <SectionTitle icon={<Banknote className="w-4 h-4" />} title="Loan Details" />
            <p className="text-xs text-gray-500 mb-5">
              Walk the customer through every term below before requesting their OTP. The OTP is
              their binding acceptance of these terms.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4 text-sm">
              <Field label="Loan Amount" value={fmtINR(loan.loan_amount)} highlight />
              <Field label="Down Payment" value={fmtINR(loan.down_payment)} />
              <Field label="Disbursement" value={fmtINR(loan.disbursement_amount)} />
              <Field label="EMI" value={`${fmtINR(loan.emi)} / mo`} highlight />
              <Field label="Tenure" value={loan.tenure_months ? `${loan.tenure_months} months` : "—"} />
              <Field label="ROI" value={loan.roi ? `${loan.roi}% p.a.` : "—"} />
              <Field label="File Charge" value={fmtINR(loan.file_charge)} />
              <Field label="Subvention" value={fmtINR(loan.subvention)} />
              <Field label="Lender" value={loan.loan_approved_by ?? "—"} />
              <Field
                label="Loan File #"
                value={
                  loan.loan_file_number ? (
                    <span className="font-mono text-xs">{loan.loan_file_number}</span>
                  ) : (
                    "—"
                  )
                }
              />
            </div>
          </section>
        )}

        {/* ─── Product Summary ───────────────────────────────────────────── */}
        {product && (
          <section className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
            <SectionTitle icon={<Package className="w-4 h-4" />} title="Product Summary" />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4 text-sm">
              <Field
                label="Battery Serial"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <Battery className="w-3.5 h-3.5 text-gray-400" />
                    <span className="font-mono">{product.battery_serial ?? "—"}</span>
                  </span>
                }
              />
              <Field
                label="Charger Serial"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <Plug className="w-3.5 h-3.5 text-gray-400" />
                    <span className="font-mono">{product.charger_serial ?? "—"}</span>
                  </span>
                }
              />
              <Field
                label="Category"
                value={
                  product.category && product.sub_category
                    ? `${product.category} · ${product.sub_category}`
                    : product.category || "—"
                }
              />
              <Field label="Dealer Margin" value={fmtINR(product.dealer_margin)} />
              <Field label="Final Price" value={fmtINR(product.final_price)} highlight />
              <Field
                label="Paraphernalia"
                value={
                  paraphernaliaItems.length > 0 ? (
                    <span className="text-xs">{paraphernaliaItems.join(", ")}</span>
                  ) : (
                    <span className="text-xs text-gray-400">None</span>
                  )
                }
              />
            </div>
          </section>
        )}

        {/* ─── OTP Confirmation ──────────────────────────────────────────── */}
        <section className="bg-white border-2 border-[#0047AB]/20 rounded-2xl p-6 shadow-sm">
          <SectionTitle icon={<Phone className="w-4 h-4" />} title="Customer OTP Confirmation" />
          <p className="text-xs text-gray-500 mb-5">
            The 6-digit OTP serves as the customer&apos;s digital acceptance of the loan terms and
            authorises dispatch. It cannot be undone once submitted.
          </p>

          {!showOtpUi && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-gray-700">
                <Phone className="w-4 h-4 text-gray-400" />
                Will be sent to{" "}
                <span className="font-bold font-mono">{data.phone ?? "—"}</span>
              </div>
              <button
                onClick={handleSendOtp}
                disabled={sending}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-[#0047AB] hover:bg-[#003580] text-white rounded-xl font-bold text-sm transition-colors disabled:opacity-50"
              >
                {sending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ArrowRight className="w-4 h-4" />
                )}
                {sending ? "Sending…" : "Send OTP to Customer"}
              </button>
            </div>
          )}

          {showOtpUi && (
            <div className="space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 text-xs">
                <span className="text-gray-500">OTP sent to:</span>
                <span className="font-bold font-mono text-gray-900">
                  {otpSentTo ?? data.phone}
                </span>
                <span className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 rounded-full text-gray-700 font-bold">
                  <Clock className="w-3 h-3" />
                  {secondsLeft > 0
                    ? `Expires in ${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
                    : "OTP expired"}
                </span>
              </div>

              {devOtp && (
                <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900">
                  <div className="text-xs">
                    <span className="font-bold">Dev / test mode:</span> SMS provider not
                    configured. Use OTP{" "}
                    <span className="font-mono font-black tracking-widest text-base">
                      {devOtp}
                    </span>{" "}
                    — would normally arrive on the customer&apos;s phone.
                  </div>
                  <button
                    onClick={() => {
                      setOtpDigits(devOtp.split(""));
                      inputsRef.current[5]?.focus();
                    }}
                    className="flex-shrink-0 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold"
                  >
                    Autofill
                  </button>
                </div>
              )}

              <div className="flex justify-center gap-2 sm:gap-3">
                {otpDigits.map((d, i) => (
                  <input
                    key={i}
                    ref={(el) => {
                      inputsRef.current[i] = el;
                    }}
                    value={d}
                    onChange={(e) => handleOtpChange(i, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(i, e)}
                    onPaste={handleOtpPaste}
                    inputMode="numeric"
                    maxLength={1}
                    disabled={secondsLeft <= 0}
                    className="w-11 h-14 sm:w-12 sm:h-16 text-center text-xl font-mono font-bold text-gray-900 border-2 border-gray-300 rounded-xl focus:border-[#0047AB] focus:bg-blue-50/30 outline-none transition-colors disabled:bg-gray-100 disabled:text-gray-400"
                  />
                ))}
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center gap-3 text-xs">
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSendOtp}
                    disabled={sending || resendCoolingDown || resendMaxedOut}
                    className="text-[#0047AB] font-bold hover:underline disabled:opacity-50 disabled:no-underline disabled:text-gray-400"
                  >
                    {resendMaxedOut
                      ? "Max sends reached — try again later"
                      : resendCoolingDown
                        ? `Resend available in ${secondsLeft - 570}s`
                        : "Resend OTP"}
                  </button>
                  <span className="text-gray-400">
                    {sendCount}/{maxSends} sends used
                  </span>
                </div>
                <button
                  onClick={handleConfirm}
                  disabled={
                    confirming || otpDigits.join("").length !== 6 || secondsLeft <= 0
                  }
                  className="ml-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-sm transition-colors disabled:opacity-50"
                >
                  {confirming ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4" />
                  )}
                  {confirming ? "Confirming…" : "Validate & Confirm Dispatch"}
                </button>
              </div>

              {otp && otp.attemptCount > 0 && !otp.isUsed && (
                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                  Wrong attempts so far: <strong>{otp.attemptCount}</strong> / 3. After 3 wrong
                  attempts the OTP will lock for 5 minutes.
                </p>
              )}
            </div>
          )}
        </section>

        <p className="text-[11px] text-gray-400 text-center pt-2">
          Step 5 finalises the sale: inventory marked sold, warranty activated, after-sales record
          opened, and the customer notified — all in a single transaction.
        </p>
      </div>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="w-7 h-7 rounded-full bg-[#0047AB]/10 text-[#0047AB] flex items-center justify-center">
        {icon}
      </span>
      <h2 className="font-bold text-gray-900">{title}</h2>
    </div>
  );
}

function Field({
  label,
  value,
  highlight,
}: {
  label: string;
  value: React.ReactNode | string | null | undefined;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wider font-bold">{label}</div>
      <div
        className={`mt-1 ${highlight ? "font-black text-gray-900 text-base" : "font-medium text-gray-900 text-sm"}`}
      >
        {value ?? "—"}
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wider font-bold">{label}</div>
      <div className="text-gray-900 font-medium">{value}</div>
    </div>
  );
}

function ActionRow({
  title,
  description,
  onClick,
  tone,
  busy,
}: {
  title: string;
  description: string;
  onClick: () => void;
  tone: "primary" | "outline" | "muted";
  busy?: boolean;
}) {
  const toneCls =
    tone === "primary"
      ? "bg-[#0047AB] hover:bg-[#003580] text-white border-transparent"
      : tone === "outline"
        ? "bg-white hover:bg-blue-50 text-[#0047AB] border-[#0047AB]"
        : "bg-white hover:bg-gray-50 text-gray-700 border-gray-300";
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`w-full flex items-center justify-between gap-4 px-4 py-3 rounded-xl border-2 ${toneCls} font-bold text-sm transition-colors disabled:opacity-50 text-left`}
    >
      <div className="flex-1">
        <div>{title}</div>
        <div
          className={`text-[11px] font-medium mt-0.5 ${tone === "primary" ? "text-white/80" : "text-gray-500"}`}
        >
          {description}
        </div>
      </div>
      {busy ? (
        <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
      ) : (
        <ArrowRight className="w-4 h-4 flex-shrink-0" />
      )}
    </button>
  );
}

function ProgressHeader({ leadId, active }: { leadId: string; active: number }) {
  void leadId;
  const steps = ["Lead", "KYC", "Docs", "Product", "Dispatch"];
  return (
    <div className="flex items-center gap-2 text-[11px] font-bold text-gray-400">
      {steps.map((s, i) => {
        const idx = i + 1;
        const done = idx < active;
        const cur = idx === active;
        return (
          <span key={s} className="flex items-center gap-2">
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                done
                  ? "bg-emerald-500 text-white"
                  : cur
                    ? "bg-[#0047AB] text-white"
                    : "bg-gray-200 text-gray-500"
              }`}
            >
              {done ? "✓" : idx}
            </span>
            <span
              className={`uppercase tracking-wider ${cur ? "text-[#0047AB]" : done ? "text-emerald-700" : ""}`}
            >
              {s}
            </span>
            {idx < steps.length && <span className="text-gray-300">›</span>}
          </span>
        );
      })}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatParaphernalia(p: Record<string, unknown> | null | undefined): string[] {
  if (!p) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(p)) {
    if (value == null || value === "" || value === 0 || value === false) continue;
    const label = key
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    if (typeof value === "number") {
      out.push(`${label} ×${value}`);
    } else if (typeof value === "boolean") {
      out.push(label);
    } else if (typeof value === "string") {
      out.push(`${label}: ${value}`);
    } else if (Array.isArray(value)) {
      if (value.length > 0) out.push(`${label}: ${value.join(", ")}`);
    } else {
      out.push(`${label}: ${JSON.stringify(value)}`);
    }
  }
  return out;
}
