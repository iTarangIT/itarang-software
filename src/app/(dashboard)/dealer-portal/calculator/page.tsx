"use client";

import { useEffect, useState } from "react";
import {
  Loader2,
  Calculator,
  Phone,
  Mail,
  MessageCircle,
  AlertCircle,
  ShieldCheck,
} from "lucide-react";
import { SchemeCardView } from "@/components/dealer-dashboard/calculator/SchemeCardView";
import type { CalcResponse, ConfigMeta } from "@/components/dealer-dashboard/calculator/types";

interface FormState {
  customerName: string;
  phone: string;
  city: string;
  modelId: string;
  tenure: string;
  expectedEmi: string;
  upfrontAbility: string;
}

const EMPTY: FormState = {
  customerName: "",
  phone: "",
  city: "",
  modelId: "",
  tenure: "",
  expectedEmi: "",
  upfrontAbility: "",
};

// Mirrors normalizeCalcPhone on the server — used only to decide when a phone
// edit invalidates the current verification.
function normalizePhone(raw: string): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return null;
}

type OtpStage = "idle" | "sending" | "sent" | "verifying" | "verified";

interface OtpInfo {
  sentTo: string;
  sendCount: number;
  maxSends: number;
  channel: "voice_call" | "whatsapp" | "dev_hardcoded";
}

const RESEND_WAIT_MS = 30 * 1000;

export default function LoanCalculatorPage() {
  const [meta, setMeta] = useState<ConfigMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [result, setResult] = useState<CalcResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // OTP gate — the customer's WhatsApp number must be verified before Calculate.
  const [otpStage, setOtpStage] = useState<OtpStage>("idle");
  const [otpInput, setOtpInput] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpInfo, setOtpInfo] = useState<OtpInfo | null>(null);
  const [resendAvailableAt, setResendAvailableAt] = useState<number | null>(null);
  const [verifiedPhone, setVerifiedPhone] = useState<string | null>(null);
  const [waBanner, setWaBanner] = useState<"sent" | "failed" | "skipped" | null>(null);
  const [tick, setTick] = useState(0); // drives the resend countdown

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/dealer/calculator/config");
        const data = await res.json();
        if (data.success) setMeta(data.data as ConfigMeta);
        else setMetaError(data.error?.message ?? "Failed to load calculator config.");
      } catch {
        setMetaError("Failed to load calculator config.");
      }
    })();
  }, []);

  useEffect(() => {
    if (otpStage !== "sent" || !resendAvailableAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [otpStage, resendAvailableAt]);
  void tick;

  const resetOtp = () => {
    setOtpStage("idle");
    setOtpInput("");
    setOtpError(null);
    setOtpInfo(null);
    setResendAvailableAt(null);
    setVerifiedPhone(null);
  };

  const set = (k: keyof FormState, v: string) => {
    // Editing the phone invalidates the current OTP verification + results.
    if (k === "phone" && normalizePhone(v) !== verifiedPhone && otpStage !== "idle") {
      resetOtp();
      setResult(null);
      setWaBanner(null);
    }
    setForm((f) => ({ ...f, [k]: v }));
  };

  const canSendOtp = !!form.customerName && !!normalizePhone(form.phone);
  const resendWaitSecs = resendAvailableAt
    ? Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1000))
    : 0;

  async function sendOtp() {
    setOtpError(null);
    if (!canSendOtp) {
      setOtpError("Enter the customer's name and a valid 10-digit mobile number first.");
      return;
    }
    const wasSent = otpStage === "sent";
    setOtpStage("sending");
    try {
      const res = await fetch("/api/dealer/calculator/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerName: form.customerName, phone: form.phone }),
      });
      const data = await res.json();
      if (data.success) {
        setOtpInfo({
          sentTo: data.data.otpSentTo,
          sendCount: data.data.sendCount,
          maxSends: data.data.maxSends,
          channel: data.data.deliveryStatus ?? "dev_hardcoded",
        });
        setOtpInput("");
        setResendAvailableAt(Date.now() + RESEND_WAIT_MS);
        setOtpStage("sent");
      } else {
        setOtpError(data.error?.message ?? "Failed to send OTP.");
        setOtpStage(wasSent ? "sent" : "idle");
      }
    } catch {
      setOtpError("Failed to send OTP. Please try again.");
      setOtpStage(wasSent ? "sent" : "idle");
    }
  }

  async function verifyOtp() {
    setOtpError(null);
    if (!/^\d{6}$/.test(otpInput)) {
      setOtpError("Enter the 6-digit OTP.");
      return;
    }
    setOtpStage("verifying");
    try {
      const res = await fetch("/api/dealer/calculator/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: form.phone, otp: otpInput }),
      });
      const data = await res.json();
      if (data.success) {
        setVerifiedPhone(normalizePhone(form.phone));
        setOtpStage("verified");
      } else {
        setOtpError(data.error?.message ?? "Verification failed.");
        setOtpStage(data.error?.code === "no_active_otp" ? "idle" : "sent");
      }
    } catch {
      setOtpError("Verification failed. Please try again.");
      setOtpStage("sent");
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setWaBanner(null);
    if (!form.customerName || !form.phone || !form.modelId || !form.tenure) {
      setError("Please fill customer name, phone, model, and tenure.");
      return;
    }
    if (otpStage !== "verified") {
      setError("Verify the customer's mobile number first.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/dealer/calculator/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: form.customerName,
          phone: form.phone,
          city: form.city || null,
          modelId: Number(form.modelId),
          tenure: Number(form.tenure),
          expectedEmi: form.expectedEmi ? Number(form.expectedEmi) : undefined,
          upfrontAbility: form.upfrontAbility ? Number(form.upfrontAbility) : undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setResult(data.data as CalcResponse);
        setWaBanner(data.data.waResults?.status ?? null);
        // The OTP is single-use — the server consumed it for this calculation,
        // so a new search needs a fresh OTP sent to the customer.
        resetOtp();
      } else if (data.error?.code === "otp_required") {
        resetOtp();
        setError("Verification used or expired — send a new OTP to the customer.");
      } else {
        setError(data.error?.message ?? "Calculation failed.");
      }
    } catch {
      setError("Calculation failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      <div className="max-w-[1400px] mx-auto px-6 py-8">
        <header className="mb-8 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gray-900 text-white">
            <Calculator className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-[28px] font-black tracking-tight text-gray-900">Loan Calculator</h1>
            <p className="mt-1 text-sm text-gray-500">
              Enter a customer&apos;s details to see the EMI schemes they qualify for across eligible NBFCs.
            </p>
          </div>
        </header>

        {metaError && (
          <div className="mb-6 flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle className="h-4 w-4" /> {metaError}
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[380px_1fr]">
          {/* Card 1 — inputs */}
          <form onSubmit={onSubmit} className="h-fit rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-sm font-bold uppercase tracking-wide text-gray-400">Customer details</h2>
            <div className="space-y-3">
              <Field label="Customer name" required>
                <input className={inputCls} value={form.customerName} onChange={(e) => set("customerName", e.target.value)} placeholder="e.g. Ramesh Kumar" />
              </Field>
              <Field label="Phone" required>
                <input className={inputCls} value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+91…" />
              </Field>
              <Field label="City">
                <select className={inputCls} value={form.city} onChange={(e) => set("city", e.target.value)}>
                  <option value="">Any (Pan-India NBFCs only)</option>
                  {meta?.cities.map((c) => (
                    <option key={c.normalized} value={c.normalized}>
                      {c.display}
                      {c.stateCode ? `, ${c.stateCode}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Battery model" required>
                <select className={inputCls} value={form.modelId} onChange={(e) => set("modelId", e.target.value)}>
                  <option value="">Select model…</option>
                  {meta?.models.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName}</option>
                  ))}
                </select>
              </Field>
              <Field label="Tenure" required>
                <select className={inputCls} value={form.tenure} onChange={(e) => set("tenure", e.target.value)}>
                  <option value="">Select tenure…</option>
                  {meta?.tenures.map((t) => (
                    <option key={t} value={t}>{t} months</option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={`Expected EMI${meta?.filters.expectedEmiRequired ? " *" : ""}`}>
                  <input className={inputCls} type="number" min={0} value={form.expectedEmi} onChange={(e) => set("expectedEmi", e.target.value)} placeholder="₹/month" />
                </Field>
                <Field label={`Upfront ability${meta?.filters.upfrontRequired ? " *" : ""}`}>
                  <input className={inputCls} type="number" min={0} value={form.upfrontAbility} onChange={(e) => set("upfrontAbility", e.target.value)} placeholder="₹ total" />
                </Field>
              </div>
            </div>

            {/* Customer WhatsApp verification (OTP gate) */}
            <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-gray-500">
                <ShieldCheck className="h-3.5 w-3.5" /> Customer verification
              </p>

              {otpStage === "verified" ? (
                <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                  <ShieldCheck className="h-4 w-4" /> Customer verified — valid for one calculation
                </p>
              ) : (
                <>
                  {(otpStage === "idle" || otpStage === "sending") && (
                    <button
                      type="button"
                      onClick={sendOtp}
                      disabled={!canSendOtp || otpStage === "sending"}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-bold text-gray-800 transition hover:border-gray-400 disabled:opacity-50"
                    >
                      {otpStage === "sending" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Phone className="h-3.5 w-3.5" />
                      )}
                      Call customer with OTP
                    </button>
                  )}

                  {(otpStage === "sent" || otpStage === "verifying") && otpInfo && (
                    <div className="space-y-2">
                      <p className="text-xs text-gray-600">
                        {otpInfo.channel === "whatsapp" ? (
                          <>
                            OTP sent to <span className="font-semibold">{otpInfo.sentTo}</span> on
                            WhatsApp.
                          </>
                        ) : (
                          <>
                            OTP called to <span className="font-semibold">{otpInfo.sentTo}</span> —
                            the customer hears the code on an automated phone call.
                          </>
                        )}
                      </p>
                      <div className="flex gap-2">
                        <input
                          className={`${inputCls} tracking-[0.3em] text-center font-mono`}
                          inputMode="numeric"
                          maxLength={6}
                          value={otpInput}
                          onChange={(e) => setOtpInput(e.target.value.replace(/\D/g, ""))}
                          placeholder="••••••"
                        />
                        <button
                          type="button"
                          onClick={verifyOtp}
                          disabled={otpStage === "verifying" || otpInput.length !== 6}
                          className="flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-2 text-xs font-bold text-white transition hover:bg-gray-800 disabled:opacity-50"
                        >
                          {otpStage === "verifying" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                          Verify
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={sendOtp}
                        disabled={resendWaitSecs > 0 || otpInfo.sendCount >= otpInfo.maxSends}
                        className="text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-800 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Resend OTP ({otpInfo.sendCount} of {otpInfo.maxSends})
                        {resendWaitSecs > 0 ? ` — wait ${resendWaitSecs}s` : ""}
                      </button>
                    </div>
                  )}

                  {otpError && (
                    <p className="mt-2 flex items-center gap-1.5 text-xs text-red-600">
                      <AlertCircle className="h-3.5 w-3.5" /> {otpError}
                    </p>
                  )}
                </>
              )}
            </div>

            {error && (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-red-600">
                <AlertCircle className="h-3.5 w-3.5" /> {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting || !meta || otpStage !== "verified"}
              title={otpStage !== "verified" ? "Verify the customer's mobile number first" : undefined}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 py-3 text-sm font-bold text-white transition hover:bg-gray-800 disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />}
              {submitting ? "Calculating…" : "Calculate schemes"}
            </button>
            {otpStage !== "verified" && (
              <p className="mt-2 text-center text-[11px] text-gray-400">
                Verify the customer&apos;s mobile number to calculate.
              </p>
            )}
          </form>

          {/* Card 2 — results */}
          <div>
            {!result && (
              <div className="flex h-full min-h-[300px] items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-white/50 text-sm text-gray-400">
                Scheme results will appear here.
              </div>
            )}

            {result && (
              <div className="space-y-4">
                {waBanner === "sent" && (
                  <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                    <MessageCircle className="h-4 w-4" /> Schemes sent to the customer&apos;s WhatsApp.
                  </div>
                )}
                {waBanner === "failed" && (
                  <div className="flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    <AlertCircle className="h-4 w-4" /> Couldn&apos;t deliver the schemes to the customer&apos;s
                    WhatsApp — please share them manually.
                  </div>
                )}
                <Results result={result} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Results({ result }: { result: CalcResponse }) {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
        <p className="text-sm text-gray-500">
          Model <span className="font-semibold text-gray-900">{result.model.displayName}</span> ·{" "}
          {result.qualified.length} qualified, {result.stretch.length} next-best · config v{result.configVersionId ?? "?"}
        </p>
      </div>

      {result.qualified.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Qualified schemes</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {result.qualified.map((c) => (
              <SchemeCardView key={`${c.nbfc}-${c.schemeCode}`} card={c} />
            ))}
          </div>
        </section>
      )}

      {result.stretch.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">
            {result.outcome === "stretch_only" ? "Closest to qualify" : "Next best (stretch to qualify)"}
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {result.stretch.map((c) => (
              <SchemeCardView key={`${c.nbfc}-${c.schemeCode}`} card={c} />
            ))}
          </div>
        </section>
      )}

      {result.outcome === "none" && (
        <div className="rounded-2xl border border-gray-200 bg-white px-5 py-6 text-center text-sm text-gray-500">
          No schemes qualify or are close for these filters. The customer can still be contacted — please reach out to
          your nearest iTarang dealer support.
        </div>
      )}

      {/* Footer — disclaimer + contact (admin-editable, from settings) */}
      <footer className="rounded-2xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
        <p className="text-xs text-gray-500">{result.footer.disclaimer}</p>
        <div className="mt-3 flex flex-wrap gap-4 text-xs font-medium text-gray-700">
          <a href={`tel:${result.footer.phone}`} className="flex items-center gap-1.5 hover:text-gray-900">
            <Phone className="h-3.5 w-3.5" /> {result.footer.phone}
          </a>
          <a href={`mailto:${result.footer.email}`} className="flex items-center gap-1.5 hover:text-gray-900">
            <Mail className="h-3.5 w-3.5" /> {result.footer.email}
          </a>
          <a
            href={`https://wa.me/${result.footer.whatsapp.replace(/[^0-9]/g, "")}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 hover:text-gray-900"
          >
            <MessageCircle className="h-3.5 w-3.5" /> {result.footer.whatsapp}
          </a>
        </div>
      </footer>
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-gray-400 focus:bg-white";

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      {children}
    </label>
  );
}
