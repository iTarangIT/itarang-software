"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Clock3, KeyRound, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";

type Reason = "expired" | "replaced" | "other_browser" | "invalid";

const COPY: Record<Reason, { title: string; body: string }> = {
  expired: {
    title: "This link has expired",
    body: "For your security each link works for 15 minutes.",
  },
  replaced: {
    title: "A newer link was opened",
    body: "This link stopped working when a newer one was opened in this browser.",
  },
  other_browser: {
    title: "This link opens only where it was made",
    body: "For security, a view link works only in the browser it was opened from. Go back to the onboarding form and press Submit to open a new link here.",
  },
  invalid: {
    title: "This link is not valid",
    body: "Please go back to the onboarding form and press Submit again.",
  },
};

/**
 * The view-only link can't be shown (27 Nov): expired, replaced, another
 * browser, or forged. Where possible a new link opens by itself (this browser
 * still holds the link's cookie); otherwise the person goes back to the form
 * and presses Submit, or — the owner — gets a code on the registered mobile.
 */
export default function ExistingLinkGate({
  token,
  reason,
  applicationId,
}: {
  token: string;
  reason: Reason;
  applicationId: string | null;
}) {
  const [phase, setPhase] = useState<"renewing" | "ask" | "code">(reason === "expired" ? "renewing" : "ask");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tried = useRef(false);

  const renew = useCallback(async () => {
    setPhase("renewing");
    setError(null);
    try {
      const res = await fetch("/api/dealer/onboarding/existing/renew", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success && json.viewUrl) {
        window.location.replace(json.viewUrl);
        return;
      }
      setPhase("ask");
    } catch {
      setPhase("ask");
      setError("Could not open a new link. Please try again.");
    }
  }, [token]);

  useEffect(() => {
    if (reason === "expired" && !tried.current) {
      tried.current = true;
      void renew();
    }
  }, [reason, renew]);

  const sendCode = async () => {
    if (!applicationId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dealer/onboarding/resume/send-otp", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        setError(json.message || "Could not send the code.");
        return;
      }
      setSentTo(json.sentWhere ?? json.sentTo ?? null);
      setCode("");
      setPhase("code");
    } catch {
      setError("Could not send the code. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!applicationId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dealer/onboarding/resume/verify-otp", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId, code }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success && json.viewUrl) {
        window.location.replace(json.viewUrl);
        return;
      }
      setError(json.message || "That code is not right.");
    } catch {
      setError("Could not check the code. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const copy = COPY[reason];
  const Icon = reason === "expired" ? Clock3 : reason === "invalid" ? ShieldAlert : ShieldCheck;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#0F2E4A] via-[#173F63] to-[#1F5C8F] px-4 py-12">
      <div className="w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-2xl shadow-black/30">
        <div className="bg-gradient-to-r from-[#E8F1FA] to-white px-7 pb-6 pt-8">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1F5C8F] text-white shadow-lg shadow-[#1F5C8F]/30">
            <Icon className="h-7 w-7" />
          </span>
          <h1 className="mt-5 text-2xl font-bold text-[#173F63]">{copy.title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">{copy.body}</p>
        </div>

        <div className="px-7 pb-8 pt-5">
          {phase === "renewing" && (
            <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
              <Loader2 className="h-5 w-5 animate-spin text-[#1F5C8F]" /> Opening a new secure link…
            </div>
          )}

          {phase === "ask" && applicationId && reason !== "invalid" && (
            <div className="space-y-3">
              <a
                href="/dealer-onboarding"
                className="block w-full rounded-xl bg-[#1F5C8F] px-4 py-3 text-center text-sm font-semibold text-white shadow-md shadow-[#1F5C8F]/25 transition hover:bg-[#173F63]"
              >
                Back to the onboarding form
              </a>
              <button
                type="button"
                disabled={busy}
                onClick={() => void sendCode()}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                I&apos;m the owner — send a code to the registered mobile
              </button>
            </div>
          )}

          {phase === "code" && (
            <div>
              <p className="text-sm text-slate-600">
                Enter the 6-digit code we sent{sentTo ? ` to ${sentTo}` : " to the registered mobile"}.
              </p>
              <div className="mt-3 flex gap-2">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="••••••"
                  aria-label="Verification code"
                  className="min-w-0 flex-1 rounded-xl border border-slate-300 px-4 py-3 text-center text-lg font-semibold tracking-[0.5em] focus:border-[#1F5C8F] focus:outline-none focus:ring-4 focus:ring-[#1F5C8F]/10"
                />
                <button
                  type="button"
                  disabled={busy || code.length !== 6}
                  onClick={() => void verify()}
                  className="rounded-xl bg-[#1F5C8F] px-5 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
                </button>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void sendCode()}
                className="mt-3 text-sm font-medium text-[#1F5C8F] hover:underline disabled:opacity-50"
              >
                Send a new code
              </button>
            </div>
          )}

          {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

          {!(phase === "ask" && applicationId && reason !== "invalid") && (
          <a
            href="/dealer-onboarding"
            className="mt-6 block text-center text-sm font-medium text-slate-500 hover:text-[#1F5C8F]"
          >
            ← Back to the onboarding form
          </a>
          )}
        </div>
      </div>
    </div>
  );
}
