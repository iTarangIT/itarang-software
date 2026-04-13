"use client";

import { use, useEffect, useState } from "react";

// BRD §2.9.3 — Public co-borrower consent page. The dealer sends this link
// via SMS/WhatsApp after creating the Step 3 co-borrower record. The
// co-borrower opens it on their phone, reviews the consent text, enters an
// OTP-like acknowledgement, and signs digitally.
//
// The route is public (no auth) — access is gated by a random 32-byte token
// that was generated in /api/coborrower/[leadId]/send-consent.

interface PageParams {
  params: Promise<{ leadId: string; token: string }>;
}

type LoadState =
  | { kind: "loading" }
  | {
      kind: "ready";
      coBorrowerName: string;
      alreadySigned: boolean;
      leadReference: string;
    }
  | { kind: "invalid"; message: string };

export default function CoBorrowerConsentPage({ params }: PageParams) {
  const { leadId, token } = use(params);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [acknowledged, setAcknowledged] = useState(false);
  const [fullName, setFullName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          `/api/coborrowerconsent/${leadId}/${token}`,
          { method: "GET" },
        );
        const data = await res.json();
        if (!data.success) {
          setState({
            kind: "invalid",
            message: data.error?.message ?? "This consent link is invalid.",
          });
          return;
        }
        setState({
          kind: "ready",
          coBorrowerName: data.data.coBorrowerName ?? "Co-Borrower",
          alreadySigned: data.data.alreadySigned ?? false,
          leadReference: data.data.leadReference ?? leadId,
        });
        setFullName(data.data.coBorrowerName ?? "");
      } catch {
        setState({
          kind: "invalid",
          message: "Network error. Please try again.",
        });
      }
    })();
  }, [leadId, token]);

  const handleSubmit = async () => {
    if (!acknowledged) {
      setError("Please acknowledge the consent before signing.");
      return;
    }
    if (!fullName.trim()) {
      setError("Please enter your full legal name.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(
        `/api/coborrowerconsent/${leadId}/${token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ full_name: fullName.trim() }),
        },
      );
      const data = await res.json();
      if (!data.success) {
        setError(data.error?.message ?? "Failed to sign consent");
        return;
      }
      setSubmitted(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (state.kind === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-teal-600" />
      </div>
    );
  }

  if (state.kind === "invalid") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-gray-200 p-6 text-center">
          <h1 className="text-lg font-semibold text-gray-900">Invalid link</h1>
          <p className="text-sm text-gray-600 mt-2">{state.message}</p>
        </div>
      </div>
    );
  }

  if (submitted || state.alreadySigned) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-gray-200 p-6 text-center">
          <div className="w-12 h-12 mx-auto bg-green-100 text-green-700 rounded-full flex items-center justify-center text-2xl">
            ✓
          </div>
          <h1 className="text-lg font-semibold text-gray-900 mt-3">
            Consent received
          </h1>
          <p className="text-sm text-gray-600 mt-2">
            Thank you, {state.coBorrowerName}. Your consent has been recorded.
            You can close this window.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-2xl mx-auto bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-teal-50 to-white">
          <h1 className="text-xl font-bold text-gray-900">
            Co-Borrower Consent
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Reference: {state.leadReference}
          </p>
        </div>

        <div className="px-6 py-5 space-y-5">
          <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-700 space-y-3 max-h-64 overflow-y-auto">
            <p>
              I, <strong>{state.coBorrowerName || "[co-borrower]"}</strong>,
              voluntarily agree to be a co-borrower for the loan application
              submitted by the primary applicant.
            </p>
            <p>
              I authorise iTarang, its partners, and the financier to:
            </p>
            <ul className="list-disc ml-5 space-y-1">
              <li>
                Fetch my Aadhaar and PAN details via DigiLocker and Decentro
                for identity verification.
              </li>
              <li>
                Retrieve my credit bureau report (CIBIL) to assess my
                eligibility as a co-borrower.
              </li>
              <li>
                Verify my bank account via a penny-drop transaction.
              </li>
              <li>
                Store the supporting documents I upload for the duration
                required by applicable law.
              </li>
            </ul>
            <p>
              I confirm that I am 18 years of age or older and that the
              information I provide is accurate to the best of my knowledge.
            </p>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Full legal name (digital signature)
            </label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full mt-1 border border-gray-200 rounded-lg px-3 py-2 text-sm"
              placeholder="Type your full name"
            />
          </div>

          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-1"
            />
            I have read and accept the co-borrower consent terms above.
          </label>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full bg-teal-600 hover:bg-teal-700 text-white py-3 rounded-lg text-sm font-semibold disabled:opacity-50"
          >
            {submitting ? "Signing…" : "Sign consent digitally"}
          </button>
        </div>
      </div>
    </div>
  );
}
