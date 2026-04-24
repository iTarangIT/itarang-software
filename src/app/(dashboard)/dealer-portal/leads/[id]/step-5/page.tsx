"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2, AlertCircle } from "lucide-react";

// BRD V2 Part F — Step 5 OTP + Dispatch Confirmation (finance only).
// Scenario A: kyc_status = loan_sanctioned → loan panel + OTP send/entry + dispatch.
// Scenario B: kyc_status = loan_rejected → rejection banner + follow-up actions.

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
}

interface ProductSelection {
  battery_serial: string | null;
  charger_serial: string | null;
  paraphernalia: Record<string, unknown> | null;
  dealer_margin: string | null;
  final_price: string | null;
}

interface OtpState {
  id: string;
  sendCount: number;
  attemptCount: number;
  expiresAt: string;
  lockedUntil: string | null;
  isUsed: boolean;
}

interface StatusData {
  leadStatus: string;
  phone: string | null;
  productSelection: ProductSelection | null;
  loanSanction: LoanSanction | null;
  otp: OtpState | null;
}

export default function Step5Page() {
  const params = useParams();
  const router = useRouter();
  const leadId = params.id as string;

  const [data, setData] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [otpSentTo, setOtpSentTo] = useState<string | null>(null);
  const [otpDigits, setOtpDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState<null | { warrantyId: string }>(null);

  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  const load = async () => {
    try {
      const res = await fetch(`/api/lead/${leadId}/step-5/status`);
      const json = await res.json();
      if (json.success) {
        setData(json.data);
        if (json.data.otp?.expiresAt) {
          const ms = new Date(json.data.otp.expiresAt).getTime() - Date.now();
          setSecondsLeft(Math.max(0, Math.floor(ms / 1000)));
        }
      } else {
        setError(json.error?.message || "Failed to load");
      }
    } catch {
      setError("Failed to load Step 5 state");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [leadId]);

  // Countdown
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
        setConfirmed({ warrantyId: json.data.warrantyId });
      } else {
        setError(json.error?.message || "OTP validation failed");
      }
    } catch {
      setError("OTP validation failed");
    } finally {
      setConfirming(false);
    }
  };

  if (loading) return <div className="p-8">Loading…</div>;
  if (!data) return <div className="p-8 text-red-600">{error || "No data"}</div>;

  // Confirmed view
  if (confirmed) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-10 text-center">
          <CheckCircle2 className="w-14 h-14 text-emerald-600 mx-auto mb-4" />
          <h2 className="text-xl font-black text-emerald-900">Dispatch Confirmed</h2>
          <p className="text-sm text-emerald-700 mt-2">
            Warranty <strong>{confirmed.warrantyId}</strong> activated. Customer has been notified.
          </p>
          <button
            onClick={() => router.push("/dealer-portal/leads")}
            className="mt-6 px-6 py-2 bg-[#0047AB] text-white rounded-xl font-bold text-sm"
          >
            Back to Leads
          </button>
        </div>
      </div>
    );
  }

  // Scenario B — loan rejected
  if (data.leadStatus === "loan_rejected" || data.loanSanction?.status === "rejected") {
    return (
      <div className="max-w-3xl mx-auto p-8 space-y-4">
        <header>
          <h1 className="text-2xl font-black">Step 5 — Loan Rejected</h1>
          <p className="text-sm text-gray-500">Lead {leadId}</p>
        </header>
        <div className="bg-red-50 border border-red-200 rounded-xl p-6">
          <h2 className="font-bold text-red-900">Loan Application Rejected</h2>
          <p className="text-sm text-red-700 mt-2">
            {data.loanSanction?.rejection_reason || "Loan application was not approved."}
          </p>
          {data.loanSanction?.loan_approved_by && (
            <p className="text-xs text-red-600 mt-1">By: {data.loanSanction.loan_approved_by}</p>
          )}
          <p className="text-xs text-gray-600 mt-4">
            Inventory has been released. Battery {data.productSelection?.battery_serial} and Charger{" "}
            {data.productSelection?.charger_serial} are available again.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => router.push(`/dealer-portal/leads/${leadId}/kyc/interim`)}
            className="px-5 py-2 bg-[#0047AB] text-white rounded font-bold text-sm"
          >
            Re-apply with Co-Borrower
          </button>
          <button
            onClick={() => router.push(`/dealer-portal/leads/${leadId}/product-selection`)}
            className="px-5 py-2 border-2 border-[#0047AB] text-[#0047AB] rounded font-bold text-sm"
          >
            Change to Cash / Re-select Product
          </button>
          <button
            onClick={() => router.push("/dealer-portal/leads")}
            className="px-5 py-2 bg-gray-200 rounded font-bold text-sm"
          >
            Close Lead
          </button>
        </div>
      </div>
    );
  }

  // Scenario A — loan sanctioned
  const loan = data.loanSanction;
  const product = data.productSelection;
  const mm = Math.floor(secondsLeft / 60);
  const ss = secondsLeft % 60;

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black">Step 5 — Loan Details & Dispatch</h1>
          <p className="text-sm text-gray-500">Lead {leadId}</p>
        </div>
        <span className="px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold">
          Loan Sanctioned — Pending Customer OTP
        </span>
      </header>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 mt-0.5" /> {error}
        </div>
      )}

      {loan && (
        <section className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="font-bold mb-4">Loan Details</h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <Field label="Loan Amount" value={`₹${loan.loan_amount}`} />
            <Field label="Down Payment" value={`₹${loan.down_payment}`} />
            <Field label="File Charge" value={`₹${loan.file_charge}`} />
            <Field label="Subvention" value={`₹${loan.subvention}`} />
            <Field label="Disbursement" value={`₹${loan.disbursement_amount}`} />
            <Field label="EMI" value={`₹${loan.emi}/month`} />
            <Field label="Tenure" value={`${loan.tenure_months} months`} />
            <Field label="ROI" value={`${loan.roi}% p.a.`} />
            <Field label="Lender" value={loan.loan_approved_by} />
            <Field label="Loan File #" value={loan.loan_file_number} />
          </div>
        </section>
      )}

      {product && (
        <section className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="font-bold mb-4">Product Summary</h2>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <Field label="Battery Serial" value={product.battery_serial} />
            <Field label="Charger Serial" value={product.charger_serial} />
            <Field label="Dealer Margin" value={`₹${product.dealer_margin ?? 0}`} />
            <Field label="Final Price" value={<strong>₹{product.final_price ?? 0}</strong>} />
          </div>
        </section>
      )}

      <section className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="font-bold mb-4">Customer OTP Confirmation</h2>
        <p className="text-sm text-gray-600 mb-4">
          OTP will be sent to customer phone {data.phone ?? "—"}.
        </p>

        {(!data.otp || data.otp.isUsed) && !otpSentTo && (
          <button
            onClick={handleSendOtp}
            disabled={sending}
            className="px-5 py-2 bg-[#0047AB] text-white rounded font-bold text-sm disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send OTP to Customer"}
          </button>
        )}

        {(otpSentTo || (data.otp && !data.otp.isUsed)) && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Sent to:</span>
              <span className="font-bold text-sm">{otpSentTo ?? data.phone}</span>
              {secondsLeft > 0 && (
                <span className="ml-auto text-xs font-bold text-gray-700">
                  Expires in {String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              {otpDigits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    inputsRef.current[i] = el;
                  }}
                  value={d}
                  onChange={(e) => handleOtpChange(i, e.target.value)}
                  onPaste={handleOtpPaste}
                  inputMode="numeric"
                  maxLength={1}
                  className="w-12 h-14 text-center text-lg font-bold border-2 border-gray-300 rounded focus:border-[#0047AB] outline-none"
                />
              ))}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleSendOtp}
                disabled={sending || secondsLeft > 570}
                className="text-sm text-[#0047AB] hover:underline disabled:opacity-50"
              >
                Resend OTP
              </button>
              <button
                onClick={handleConfirm}
                disabled={confirming || otpDigits.join("").length !== 6}
                className="ml-auto px-5 py-2 bg-emerald-600 text-white rounded font-bold text-sm disabled:opacity-50"
              >
                {confirming ? "Confirming…" : "Validate & Confirm Dispatch"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode | string | null | undefined }) {
  return (
    <div>
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="font-medium text-gray-900">{value ?? "—"}</div>
    </div>
  );
}
