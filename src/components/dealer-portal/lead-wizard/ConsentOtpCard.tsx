"use client";

// OTP-based consent capture (E-180) — replaces Digio Aadhaar e-sign.
//
// The OTP is delivered to the customer by an automated VOICE CALL (2Factor). The
// dealer taps "Send OTP via Call", the customer answers, reads out the 6 digits,
// the dealer types them here, ticks the confirmation checkbox, and verifies — the
// consent is then recorded as verified. A small card lets anyone view the consent
// PDF first. WhatsApp delivery is "coming soon".

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Loader2,
  MessageCircle,
  Phone,
} from "lucide-react";

type ConsentFor = "customer" | "borrower";

interface Props {
  leadId: string;
  /** 'customer' (primary) or 'borrower' (co-borrower). */
  consentFor: ConsentFor;
  /** Display-only phone the OTP call goes to. */
  phone?: string | null;
  /** Fired once the OTP is verified and consent is recorded. */
  onVerified: () => void;
  /** Optional gate run before sending (e.g. persist the co-borrower row first).
   *  Return false to abort the send. */
  beforeSend?: () => Promise<boolean>;
  className?: string;
}

export default function ConsentOtpCard({
  leadId,
  consentFor,
  phone,
  onVerified,
  beforeSend,
  className = "",
}: Props) {
  const [stage, setStage] = useState<"idle" | "sent">("idle");
  const [otpSentTo, setOtpSentTo] = useState<string | null>(null);
  const [digits, setDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [sendCount, setSendCount] = useState(0);
  const [maxSends, setMaxSends] = useState(3);
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);

  // Consent PDF preview (lazily rendered on first click).
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);

  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [secondsLeft]);

  const viewConsentPdf = async () => {
    if (pdfUrl) {
      window.open(pdfUrl, "_blank", "noopener,noreferrer");
      return;
    }
    setPdfLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/kyc/${leadId}/consent-preview?consent_for=${consentFor}`,
      );
      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error?.message || "Couldn't open the consent form");
      }
      setPdfUrl(json.data.url);
      window.open(json.data.url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setError(e?.message || "Couldn't open the consent form");
    } finally {
      setPdfLoading(false);
    }
  };

  const send = async () => {
    setSending(true);
    setError(null);
    setAttemptsLeft(null);
    try {
      if (beforeSend) {
        const ok = await beforeSend();
        if (!ok) {
          setSending(false);
          return;
        }
      }
      const res = await fetch(`/api/kyc/${leadId}/send-consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "call", consent_for: consentFor, method: "otp" }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error?.message || "Failed to place the OTP call");
      }
      setStage("sent");
      setConfirmed(false);
      setOtpSentTo(json.data?.otpSentTo ?? null);
      setSecondsLeft(json.data?.expiresInSeconds || 600);
      setSendCount(json.data?.sendCount ?? 1);
      setMaxSends(json.data?.maxSends ?? 3);
      setDevOtp(json.data?._devOtp ?? null);
      setDigits(["", "", "", "", "", ""]);
      if (json.data?.previewUrl) setPdfUrl(json.data.previewUrl);
      setTimeout(() => inputsRef.current[0]?.focus(), 0);
    } catch (e: any) {
      setError(e?.message || "Failed to place the OTP call");
    } finally {
      setSending(false);
    }
  };

  const onDigitChange = (i: number, v: string) => {
    const digit = v.replace(/\D/g, "").slice(-1);
    setDigits((prev) => {
      const next = [...prev];
      next[i] = digit;
      return next;
    });
    if (digit && i < 5) inputsRef.current[i + 1]?.focus();
  };

  const onKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[i] && i > 0) inputsRef.current[i - 1]?.focus();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 6) {
      e.preventDefault();
      setDigits(pasted.split(""));
      inputsRef.current[5]?.focus();
    }
  };

  const verify = async () => {
    const otp = digits.join("");
    if (otp.length !== 6) {
      setError("Enter all 6 digits");
      return;
    }
    if (!confirmed) {
      setError("Tick the confirmation checkbox to record consent");
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      const res = await fetch(`/api/kyc/${leadId}/verify-consent-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otp, consent_for: consentFor }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        if (json?.data?.attemptsRemaining !== undefined) {
          setAttemptsLeft(json.data.attemptsRemaining);
        }
        throw new Error(json?.error?.message || "OTP verification failed");
      }
      onVerified();
    } catch (e: any) {
      setError(e?.message || "OTP verification failed");
    } finally {
      setVerifying(false);
    }
  };

  const mm = Math.floor(secondsLeft / 60);
  const ss = secondsLeft % 60;
  const resendCoolingDown = secondsLeft > 570;
  const resendMaxedOut = sendCount >= maxSends;

  // Small clickable card to view the consent PDF — shown in both stages.
  const pdfCard = (
    <button
      type="button"
      onClick={viewConsentPdf}
      disabled={pdfLoading}
      className="w-full flex items-center gap-3 p-3 rounded-xl border-2 border-gray-200 bg-white hover:border-[#0047AB] hover:shadow-sm transition-all text-left disabled:opacity-60"
    >
      <div className="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
        {pdfLoading ? (
          <Loader2 className="w-4 h-4 text-[#0047AB] animate-spin" />
        ) : (
          <FileText className="w-4 h-4 text-[#0047AB]" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-gray-900">View consent form</p>
        <p className="text-[11px] text-gray-500">
          {pdfLoading ? "Preparing the PDF…" : "Open the consent PDF the customer is agreeing to"}
        </p>
      </div>
      <ExternalLink className="w-4 h-4 text-gray-400 flex-shrink-0" />
    </button>
  );

  return (
    <div className={`space-y-3 ${className}`}>
      {pdfCard}

      {stage === "idle" ? (
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            An automated call reads a 6-digit OTP to the customer. Ask them to share it, then enter
            it below to record their consent.
          </p>
          <div className="flex items-center gap-2 text-xs text-gray-700">
            <Phone className="w-3.5 h-3.5 text-gray-400" />
            OTP call to <span className="font-bold font-mono">{phone || "—"}</span>
          </div>
          <button
            onClick={send}
            disabled={sending}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#0047AB] hover:bg-[#003580] text-white rounded-xl font-bold text-sm transition-colors disabled:opacity-50"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Phone className="w-4 h-4" />}
            {sending ? "Calling…" : "Send OTP via Call"}
          </button>
          <div className="flex flex-col">
            <button
              disabled
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#25D366] text-white rounded-xl font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <MessageCircle className="w-4 h-4" /> Send OTP via WhatsApp
            </button>
            <span className="text-[10px] text-gray-500 font-medium text-center mt-1">Coming Soon</span>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 text-xs">
            <span className="text-gray-500">OTP called to:</span>
            <span className="font-bold font-mono text-gray-900">{otpSentTo ?? phone}</span>
            <span className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 rounded-full text-gray-700 font-bold">
              <Clock className="w-3 h-3" />
              {secondsLeft > 0
                ? `Expires in ${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
                : "OTP expired"}
            </span>
          </div>

          <div className="flex justify-center gap-2 sm:gap-3">
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => {
                  inputsRef.current[i] = el;
                }}
                value={d}
                onChange={(e) => onDigitChange(i, e.target.value)}
                onKeyDown={(e) => onKeyDown(i, e)}
                onPaste={onPaste}
                inputMode="numeric"
                maxLength={1}
                disabled={secondsLeft <= 0}
                className="w-11 h-14 sm:w-12 sm:h-16 text-center text-xl font-mono font-bold text-gray-900 border-2 border-gray-300 rounded-xl focus:border-[#0047AB] focus:bg-blue-50/30 outline-none transition-colors disabled:bg-gray-100 disabled:text-gray-400"
              />
            ))}
          </div>

          <label className="flex items-start gap-2.5 p-3 rounded-xl border-2 border-gray-200 bg-white cursor-pointer hover:border-[#0047AB] transition-colors">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-[#0047AB]"
            />
            <span className="text-xs text-gray-700">
              I confirm the customer has reviewed the consent form and shared the OTP as their
              consent to KYC &amp; loan processing.
            </span>
          </label>

          <div className="flex flex-col sm:flex-row sm:items-center gap-3 text-xs">
            <div className="flex items-center gap-3">
              <button
                onClick={send}
                disabled={sending || resendCoolingDown || resendMaxedOut}
                className="text-[#0047AB] font-bold hover:underline disabled:opacity-50 disabled:no-underline disabled:text-gray-400"
              >
                {resendMaxedOut
                  ? "Max calls reached — try again later"
                  : resendCoolingDown
                    ? `Resend available in ${secondsLeft - 570}s`
                    : "Resend OTP call"}
              </button>
              <span className="text-gray-400">
                {sendCount}/{maxSends} calls used
              </span>
            </div>
            <button
              onClick={verify}
              disabled={verifying || digits.join("").length !== 6 || !confirmed || secondsLeft <= 0}
              className="ml-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-sm transition-colors disabled:opacity-50"
            >
              {verifying ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              {verifying ? "Verifying…" : "Verify & Record Consent"}
            </button>
          </div>

          {attemptsLeft !== null && attemptsLeft > 0 && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              Incorrect OTP. <strong>{attemptsLeft}</strong> attempt(s) remaining before a 5-minute
              lock.
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}
    </div>
  );
}
