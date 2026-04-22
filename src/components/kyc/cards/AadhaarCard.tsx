"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import RequestMoreDocsModal from "../step3/RequestMoreDocsModal";

interface AadhaarCardProps {
  leadId: string;
  leadName: string;
  phone: string;
  email?: string;
  leadDob?: string;
  leadFatherName?: string;
  leadAddress?: string;
  applicant?: "primary" | "co_borrower";
  existingTransaction?: {
    id: string;
    status: string;
    aadhaarExtractedData?: Record<string, string | null> | null;
    crossMatchResult?: CrossMatchResult | null;
    expiresAt?: string;
  } | null;
  existingVerification?: {
    id: string;
    status: string;
    adminAction?: string | null;
    adminActionNotes?: string | null;
  } | null;
  onActionComplete?: () => void;
}

interface CrossMatchField {
  field: string;
  leadValue?: string | null;
  aadhaarValue?: string | null;
  // Decentro cross-match lib uses these names
  inputValue?: string | null;
  documentValue?: string | null;
  matchResult?: string;
  similarity: number;
  threshold: number;
  pass?: boolean;
  label?: string;
}

interface CrossMatchResult {
  overallPass: boolean;
  fields: CrossMatchField[];
  nameSimilarity?: number;
}

type DigilockerStep = "link_sent" | "link_opened" | "consent_given" | "document_fetched";

type CardStatus =
  | "pending"
  | "initiating"
  | "awaiting_consent"
  | "document_fetched"
  | "success"
  | "failed"
  | "expired";

const PROGRESS_STEPS: { key: DigilockerStep; label: string }[] = [
  { key: "link_sent", label: "Link Sent" },
  { key: "link_opened", label: "Link Opened" },
  { key: "consent_given", label: "DigiLocker Consent" },
  { key: "document_fetched", label: "Document Fetched" },
];

interface AadhaarTableRow {
  label: string;
  leadValue: string | null;
  aadhaarValue: string | null;
  match: { similarity: number; threshold: number; pass: boolean } | null;
}

function buildAadhaarTableRows({
  aadhaarData,
  crossMatch,
  leadName,
  leadDob,
  leadFatherName,
  leadAddress,
}: {
  aadhaarData: Record<string, string | null>;
  crossMatch: CrossMatchResult | null;
  leadName: string;
  leadDob?: string;
  leadFatherName?: string;
  leadAddress?: string;
}): AadhaarTableRow[] {
  const cmByField = new Map<string, CrossMatchField>();
  crossMatch?.fields?.forEach((f) => {
    if (f.field) cmByField.set(f.field.toLowerCase(), f);
  });

  const toMatch = (f: CrossMatchField | undefined) => {
    if (!f) return null;
    const pass = f.pass ?? (f.matchResult === "strong" || f.matchResult === "moderate");
    return { similarity: f.similarity, threshold: f.threshold, pass };
  };

  const cmLead = (f: CrossMatchField | undefined) => f?.leadValue ?? f?.inputValue ?? null;
  const cmAadhaar = (f: CrossMatchField | undefined) => f?.aadhaarValue ?? f?.documentValue ?? null;

  const gender = aadhaarData.gender === "M" ? "Male" : aadhaarData.gender === "F" ? "Female" : aadhaarData.gender || null;
  const maskedUid = aadhaarData.uid ? `XXXX-XXXX-${aadhaarData.uid.slice(-4)}` : null;

  const rows: AadhaarTableRow[] = [
    {
      label: "Name",
      leadValue: cmLead(cmByField.get("name")) || leadName || null,
      aadhaarValue: cmAadhaar(cmByField.get("name")) || aadhaarData.name || null,
      match: toMatch(cmByField.get("name")),
    },
    {
      label: "Aadhaar Number",
      leadValue: null,
      aadhaarValue: maskedUid,
      match: null,
    },
    {
      label: "Date of Birth",
      leadValue: cmLead(cmByField.get("dob")) || leadDob || null,
      aadhaarValue: cmAadhaar(cmByField.get("dob")) || aadhaarData.dob || null,
      match: toMatch(cmByField.get("dob")),
    },
    {
      label: "Gender",
      leadValue: cmLead(cmByField.get("gender")),
      aadhaarValue: cmAadhaar(cmByField.get("gender")) || gender,
      match: toMatch(cmByField.get("gender")),
    },
    {
      label: "Father / Husband",
      leadValue:
        cmLead(cmByField.get("careof")) ||
        cmLead(cmByField.get("father_name")) ||
        leadFatherName ||
        null,
      aadhaarValue:
        cmAadhaar(cmByField.get("careof")) ||
        cmAadhaar(cmByField.get("father_name")) ||
        aadhaarData.careof ||
        null,
      match: toMatch(cmByField.get("careof") || cmByField.get("father_name")),
    },
    {
      label: "Address",
      leadValue: cmLead(cmByField.get("address")) || leadAddress || null,
      aadhaarValue: cmAadhaar(cmByField.get("address")) || aadhaarData.address || null,
      match: toMatch(cmByField.get("address")),
    },
  ];

  return rows.filter((r) => r.aadhaarValue || r.leadValue);
}

export default function AadhaarCard({
  leadId,
  leadName,
  phone,
  email,
  leadDob,
  leadFatherName,
  leadAddress,
  applicant = "primary",
  existingTransaction,
  existingVerification,
  onActionComplete,
}: AadhaarCardProps) {
  const apiBase =
    applicant === "co_borrower"
      ? `/api/admin/kyc/${leadId}/coborrower`
      : `/api/admin/kyc/${leadId}`;
  const [cardStatus, setCardStatus] = useState<CardStatus>(() => {
    if (existingVerification?.adminAction === "accepted") return "success";
    if (existingVerification?.adminAction === "rejected") return "failed";
    if (existingTransaction?.status === "document_fetched") return "document_fetched";
    if (existingTransaction?.status === "expired") return "expired";
    if (existingTransaction?.status === "failed") return "failed";
    if (existingTransaction?.status && existingTransaction.status !== "idle") return "awaiting_consent";
    return "pending";
  });

  const digiOrder: DigilockerStep[] = ["link_sent", "link_opened", "consent_given", "document_fetched"];
  const [digiStatus, setDigiStatus] = useState<string>(existingTransaction?.status || "idle");
  const [transactionId, setTransactionId] = useState(existingTransaction?.id || "");
  const [aadhaarData, setAadhaarData] = useState<Record<string, string | null> | null>(
    existingTransaction?.aadhaarExtractedData || null
  );
  const [crossMatch, setCrossMatch] = useState<CrossMatchResult | null>(
    existingTransaction?.crossMatchResult || null
  );
  const [linkExpiry, setLinkExpiry] = useState(existingTransaction?.expiresAt || "");
  const [timeRemaining, setTimeRemaining] = useState("");
  const [linkValidity, setLinkValidity] = useState(24);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // When the admin explicitly wants to re-run a verification that already has
  // data on file (from dealer lead-creation or a prior admin run), flipping
  // this reveals the initiation UI without discarding the already-displayed
  // extracted data. Stays false by default so the default view is the
  // extracted-data panel, not a "Re-send DigiLocker link" prompt.
  const [rerunMode, setRerunMode] = useState(false);
  const [digilockerUrl, setDigilockerUrl] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [smsStatus, setSmsStatus] = useState<
    "delivered" | "failed" | "skipped" | "retrying" | null
  >(null);
  const [smsAttempts, setSmsAttempts] = useState(0);
  const [smsStatusMessage, setSmsStatusMessage] = useState<string | null>(null);
  const [resendingSms, setResendingSms] = useState(false);
  const [adminNotes, setAdminNotes] = useState("");
  const [actionLoading, setActionLoading] = useState("");
  const [showMoreDocsModal, setShowMoreDocsModal] = useState(false);
  const [actionResult, setActionResult] = useState<{ success: boolean; message: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollStatus = useCallback(async () => {
    if (!transactionId) return;
    try {
      const res = await fetch(`${apiBase}/aadhaar/digilocker/status/${transactionId}`);
      const data = await res.json();
      if (!data.success) return;
      const s = data.data;

      if (s.documentFetched) {
        setDigiStatus("document_fetched");
        setCardStatus("document_fetched");
        setAadhaarData(s.aadhaarData);
        setCrossMatch(s.crossMatchResult);
        if (pollRef.current) clearInterval(pollRef.current);
      } else if (s.consentGiven) {
        setDigiStatus("consent_given");
      } else if (s.linkOpened) {
        setDigiStatus("link_opened");
      }

      if (s.status === "expired") {
        setDigiStatus("expired");
        setCardStatus("expired");
        if (pollRef.current) clearInterval(pollRef.current);
      }
      setTimeRemaining(s.timeRemaining || "");

      if (s.smsStatus !== undefined) {
        // Don't overwrite "retrying" (an in-flight client-side mutation)
        // with a stale server value until the resend settles.
        setSmsStatus((prev) => (prev === "retrying" ? prev : s.smsStatus));
      }
      if (typeof s.smsAttempts === "number") setSmsAttempts(s.smsAttempts);
      if (s.smsStatusMessage !== undefined) {
        setSmsStatusMessage(s.smsStatusMessage);
      }
    } catch {
      // silent
    }
  }, [transactionId, leadId]);

  useEffect(() => {
    const terminal = ["idle", "document_fetched", "expired", "failed"];
    if (transactionId && !terminal.includes(digiStatus)) {
      pollRef.current = setInterval(pollStatus, 10000);
      return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }
  }, [transactionId, digiStatus, pollStatus]);

  useEffect(() => {
    if (!linkExpiry) return;
    const update = () => {
      const ms = new Date(linkExpiry).getTime() - Date.now();
      if (ms <= 0) { setTimeRemaining("Expired"); return; }
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      setTimeRemaining(`${h}h ${m}m remaining`);
    };
    update();
    const t = setInterval(update, 60000);
    return () => clearInterval(t);
  }, [linkExpiry]);

  const handleInitiate = async () => {
    setLoading(true);
    setError("");
    setCardStatus("initiating");
    try {
      const res = await fetch(`${apiBase}/aadhaar/digilocker/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notification_channel: "sms", link_validity_hours: linkValidity }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error?.message || "Failed to initiate DigiLocker");
        setCardStatus("failed");
        return;
      }
      setTransactionId(data.data.transactionId);
      setLinkExpiry(data.data.linkExpiresAt);
      setDigilockerUrl(data.data.digilockerUrl || "");
      setSmsStatus(data.data.smsStatus ?? null);
      setSmsAttempts(data.data.smsAttempts ?? 0);
      setSmsStatusMessage(data.data.smsStatusMessage ?? null);
      setDigiStatus("link_sent");
      setCardStatus("awaiting_consent");
    } catch {
      setError("Network error. Please try again.");
      setCardStatus("failed");
    } finally {
      setLoading(false);
    }
  };

  // Retry SMS against the existing DigiLocker session — does NOT create a
  // new session (no new Decentro DigiLocker credit spent). If the session
  // has expired, we fall back to a full re-initiate.
  const handleResendSms = async () => {
    if (resendingSms) return;
    setResendingSms(true);
    setSmsStatus("retrying");
    setError("");
    try {
      const res = await fetch(`${apiBase}/aadhaar/digilocker/resend-sms`, {
        method: "POST",
      });
      const data = await res.json();

      if (res.status === 410) {
        // Session expired — reset and trigger a fresh initiate.
        setError("Session expired. Generating a new DigiLocker link…");
        setTransactionId("");
        setDigilockerUrl("");
        setSmsStatus(null);
        setSmsAttempts(0);
        setCardStatus("pending");
        setDigiStatus("idle");
        await handleInitiate();
        return;
      }

      if (data?.data) {
        setSmsStatus(data.data.smsStatus ?? "failed");
        setSmsAttempts(data.data.smsAttempts ?? smsAttempts + 1);
        setSmsStatusMessage(data.data.smsStatusMessage ?? null);
      }
      if (!data.success) {
        setError(data.error?.message ?? "SMS resend failed");
      }
    } catch {
      setSmsStatus("failed");
      setError("Network error while resending SMS. Please retry.");
    } finally {
      setResendingSms(false);
    }
  };

  const handleAdminAction = async (action: "accept" | "reject" | "request_more_docs") => {
    if (action === "request_more_docs") { setShowMoreDocsModal(true); return; }
    if (action === "reject" && !adminNotes.trim()) {
      setError("Please provide rejection reason in admin notes");
      return;
    }
    setActionLoading(action);
    setError("");
    setActionResult(null);
    try {
      const vid = existingVerification?.id;
      const res = vid
        ? await fetch(`/api/admin/kyc/${leadId}/verification/${vid}/action`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, notes: adminNotes, rejection_reason: action === "reject" ? adminNotes : undefined }),
          })
        : await fetch(`/api/admin/kyc/${leadId}/verification/manual`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, verification_type: "aadhaar", applicant, notes: adminNotes, rejection_reason: action === "reject" ? adminNotes : undefined }),
          });
      const data = await res.json();
      if (data.success) {
        if (action === "accept") {
          setCardStatus("success");
          setActionResult({ success: true, message: "Aadhaar verification accepted successfully" });
        } else if (action === "reject") {
          setCardStatus("failed");
          setActionResult({ success: true, message: "Aadhaar verification rejected" });
        }
        onActionComplete?.();
      } else {
        setError(data.error?.message || "Action failed");
      }
    } catch {
      setError("Network error");
    } finally {
      setActionLoading("");
    }
  };

  const getStepState = (stepKey: string) => {
    const ci = digiOrder.indexOf(digiStatus as DigilockerStep);
    const si = digiOrder.indexOf(stepKey as DigilockerStep);
    if (si < ci) return "done";
    if (si === ci) return "current";
    return "waiting";
  };

  const getMatchBadge = (similarity: number, threshold: number, pass: boolean) => (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${pass ? "text-green-700" : "text-red-700"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${pass ? "bg-green-500" : "bg-red-500"}`} />
      {Math.round(similarity)}%{!pass && ` (need ${threshold}%)`}
    </span>
  );

  const statusConfig: Record<CardStatus, { bg: string; label: string }> = {
    pending: { bg: "bg-gray-100 text-gray-600", label: "Pending" },
    initiating: { bg: "bg-blue-100 text-blue-700", label: "Initiating..." },
    awaiting_consent: { bg: "bg-yellow-100 text-yellow-700", label: "Awaiting Consent" },
    document_fetched: { bg: "bg-emerald-100 text-emerald-700", label: "Document Received" },
    success: { bg: "bg-green-100 text-green-700", label: "Verified" },
    failed: { bg: "bg-red-100 text-red-700", label: "Failed" },
    expired: { bg: "bg-orange-100 text-orange-700", label: "Expired" },
  };

  return (
    <div className="border border-gray-200 rounded-xl bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-white">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-sm">A</div>
          <div>
            <h3 className="text-base font-semibold text-gray-900">Aadhaar Verification</h3>
            <p className="text-xs text-gray-500">via DigiLocker</p>
          </div>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${statusConfig[cardStatus].bg}`}>
          {statusConfig[cardStatus].label}
        </span>
      </div>

      <div className="p-5 space-y-5">
        {/* Pending / Expired: Show initiate */}
        {(cardStatus === "pending" || cardStatus === "expired") && (
          <div className="space-y-4">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-3">Customer Details</p>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-gray-400">Name</p>
                  <p className="font-medium text-gray-800">{leadName}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Mobile</p>
                  <p className="font-medium text-gray-800">{phone}</p>
                </div>
                {email && (
                  <div>
                    <p className="text-xs text-gray-400">Email</p>
                    <p className="font-medium text-gray-800">{email}</p>
                  </div>
                )}
                <div>
                  <p className="text-xs text-gray-400">Link Validity</p>
                  <select
                    value={linkValidity}
                    onChange={(e) => setLinkValidity(Number(e.target.value))}
                    className="mt-1 text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
                  >
                    <option value={24}>24 hours</option>
                    <option value={48}>48 hours</option>
                    <option value={72}>72 hours</option>
                  </select>
                </div>
              </div>
            </div>
            {cardStatus === "expired" && (
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-orange-700 text-sm">
                Previous link expired. Send a new one.
              </div>
            )}
            <button
              onClick={handleInitiate}
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {loading ? "Sending..." : "Send DigiLocker Link via SMS"}
            </button>

          </div>
        )}

        {/* Initiating spinner */}
        {cardStatus === "initiating" && (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            <span className="ml-3 text-sm text-gray-600">Sending DigiLocker link...</span>
          </div>
        )}

        {/* Awaiting Consent: Progress Tracker */}
        {cardStatus === "awaiting_consent" && (
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-blue-800">Waiting for customer action</p>
                {timeRemaining && <span className="text-xs text-blue-600 font-medium">{timeRemaining}</span>}
              </div>
              <div className="space-y-2.5">
                {PROGRESS_STEPS.map((step) => {
                  const st = getStepState(step.key);
                  return (
                    <div key={step.key} className="flex items-center gap-3">
                      {st === "done" && (
                        <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center">
                          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                        </div>
                      )}
                      {st === "current" && (
                        <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">
                          <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                        </div>
                      )}
                      {st === "waiting" && <div className="w-5 h-5 rounded-full border-2 border-gray-300" />}
                      <span className={`text-sm ${st === "done" ? "text-green-700 font-medium" : st === "current" ? "text-blue-700 font-medium" : "text-gray-400"}`}>
                        {step.label}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-blue-500 mt-3">Auto-refreshing every 10s...</p>
            </div>
            {digilockerUrl && (
              <div className="bg-white border border-gray-200 rounded-lg p-3 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                    DigiLocker Link{smsAttempts > 1 ? ` · ${smsAttempts} send attempts` : ""}
                  </p>
                  {/* SMS delivery badge */}
                  {smsStatus === "delivered" && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                      SMS sent to {phone}
                    </span>
                  )}
                  {smsStatus === "failed" && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                      SMS failed
                    </span>
                  )}
                  {smsStatus === "retrying" && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                      Resending…
                    </span>
                  )}
                  {smsStatus === "skipped" && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-gray-700 bg-gray-50 border border-gray-200 rounded-full px-2 py-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                      SMS not configured
                    </span>
                  )}
                </div>

                {/* Contextual note — only when SMS didn't land */}
                {smsStatus !== "delivered" && (
                  <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1">
                    {smsStatus === "failed"
                      ? `SMS delivery failed${smsStatusMessage ? `: ${smsStatusMessage}` : ""}. Tap Resend SMS below or copy the link and share it with the customer.`
                      : smsStatus === "skipped"
                        ? "Decentro SMS is not enabled on this deploy. Copy the link and share it with the customer."
                        : "If the customer didn't receive the SMS, tap Resend SMS or copy the link and share it with them."}
                  </p>
                )}

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={digilockerUrl}
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                    className="flex-1 text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 truncate"
                  />
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(digilockerUrl);
                        setLinkCopied(true);
                        setTimeout(() => setLinkCopied(false), 2000);
                      } catch {
                        setLinkCopied(false);
                      }
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded transition-colors whitespace-nowrap"
                  >
                    {linkCopied ? "✓ Copied" : "Copy"}
                  </button>
                  <a
                    href={digilockerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors whitespace-nowrap"
                  >
                    Open
                  </a>
                </div>
              </div>
            )}
            {transactionId && <p className="text-xs text-gray-400">Transaction: {transactionId}</p>}
            <div className="flex gap-2">
              <button
                onClick={handleResendSms}
                disabled={resendingSms || !transactionId}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {resendingSms ? "Resending…" : "Resend SMS"}
              </button>
              <button
                onClick={pollStatus}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Refresh
              </button>
              {/* Last-resort: destroy the session and start a fresh initiate */}
              <button
                onClick={() => {
                  setTransactionId("");
                  setDigiStatus("idle");
                  setCardStatus("pending");
                  setDigilockerUrl("");
                  setSmsStatus(null);
                  setSmsAttempts(0);
                  setError("");
                }}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-transparent hover:bg-gray-100 rounded-lg transition-colors"
                title="Discard this session and create a brand new DigiLocker link (uses a new Decentro credit)"
              >
                New Link
              </button>
            </div>
          </div>
        )}

        {/* Document Fetched / Success / Failed — always render on a terminal
            state so the admin can re-run, even if no DigiLocker data is yet
            on file (e.g. dealer skipped step 1 or prior run failed). The
            data and crossmatch sub-blocks gate themselves on their own data. */}
        {(cardStatus === "document_fetched" || cardStatus === "success" || cardStatus === "failed") && (
          <div className="space-y-4">
            {aadhaarData ? (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide">
                    Aadhaar Verification Results
                  </p>
                  {crossMatch && (
                    <span className={`px-3 py-1 rounded-full text-xs font-semibold ${crossMatch.overallPass ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                      {crossMatch.overallPass ? "Overall Pass" : "Overall Fail"}
                    </span>
                  )}
                </div>
                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Field Name</th>
                        <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">As per Lead</th>
                        <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">As per Aadhaar (DigiLocker)</th>
                        <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase">Match</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {buildAadhaarTableRows({
                        aadhaarData,
                        crossMatch,
                        leadName,
                        leadDob,
                        leadFatherName,
                        leadAddress,
                      }).map((row, i) => {
                        const rowFailed = row.match && !row.match.pass && row.match.similarity !== null;
                        return (
                          <tr key={`${row.label}-${i}`} className={`hover:bg-gray-50/50 ${rowFailed ? "bg-red-50/30" : ""}`}>
                            <td className="px-3 py-2.5 font-semibold text-gray-800">{row.label}</td>
                            <td
                              className="px-3 py-2.5 text-gray-600 max-w-[160px] truncate"
                              title={row.leadValue || undefined}
                            >
                              {row.leadValue || <span className="text-gray-300">—</span>}
                            </td>
                            <td
                              className="px-3 py-2.5 text-gray-600 max-w-[160px] truncate font-mono text-xs"
                              title={row.aadhaarValue || undefined}
                            >
                              {row.aadhaarValue || <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-3 py-2.5">
                              {row.match
                                ? getMatchBadge(row.match.similarity, row.match.threshold, row.match.pass)
                                : <span className="text-gray-400 text-xs">N/A</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="bg-gray-50 border border-dashed border-gray-200 rounded-lg p-4 text-center">
                <p className="text-sm text-gray-500">No Aadhaar data on file yet.</p>
                <p className="text-xs text-gray-400 mt-0.5">Re-run the verification below to fetch it from DigiLocker.</p>
              </div>
            )}

            {/* Re-run toggle — default shows extracted data; admin opts into
                a fresh DigiLocker flow only if the document needs re-fetching. */}
            {!rerunMode ? (
              <button
                onClick={() => setRerunMode(true)}
                className="w-full bg-teal-600 hover:bg-teal-700 text-white py-2.5 rounded-lg text-sm font-medium transition-colors"
              >
                Re-run Aadhaar Verification
              </button>
            ) : (
              <div className="space-y-2 bg-blue-50 border border-blue-100 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-blue-800 uppercase tracking-wide">Send a new DigiLocker link</p>
                  <button
                    onClick={() => setRerunMode(false)}
                    className="text-xs text-gray-500 hover:text-gray-700"
                  >
                    Cancel
                  </button>
                </div>
                <button
                  onClick={handleInitiate}
                  disabled={loading}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                >
                  {loading ? "Sending..." : "Re-send DigiLocker Link via SMS"}
                </button>
              </div>
            )}

          </div>
        )}

        {/* Admin Actions — Always visible */}
        {cardStatus !== "initiating" && (
          <div className="space-y-3 pt-4 border-t border-gray-200">
            {(existingVerification?.adminAction || actionResult) && (
              <div className={`rounded-lg p-3 text-sm font-medium flex items-center gap-2 ${
                (existingVerification?.adminAction === "accepted" || actionResult?.success)
                  ? "bg-green-50 border border-green-200 text-green-700"
                  : "bg-red-50 border border-red-200 text-red-700"
              }`}>
                <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  {(existingVerification?.adminAction === "accepted" || (actionResult?.success && actionResult.message.includes("accepted")))
                    ? <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    : <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  }
                </svg>
                {actionResult?.message || `Aadhaar verification ${existingVerification?.adminAction} by admin.`}
              </div>
            )}
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Admin Notes</label>
              <textarea value={adminNotes} onChange={(e) => setAdminNotes(e.target.value)} rows={2}
                placeholder="Add verification remarks..."
                className="w-full mt-1.5 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none" />
            </div>
            <div className="flex gap-2">
              <button onClick={() => handleAdminAction("accept")} disabled={!!actionLoading}
                className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors shadow-sm">
                {actionLoading === "accept" ? "Accepting..." : "Accept"}
              </button>
              <button onClick={() => handleAdminAction("reject")} disabled={!!actionLoading}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors shadow-sm">
                {actionLoading === "reject" ? "Rejecting..." : "Reject"}
              </button>
              <button onClick={() => handleAdminAction("request_more_docs")} disabled={!!actionLoading}
                className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors shadow-sm">
                Request Docs
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">{error}</div>
        )}
      </div>

      <RequestMoreDocsModal
        open={showMoreDocsModal}
        onClose={() => setShowMoreDocsModal(false)}
        leadId={leadId}
        sourceVerificationId={existingVerification?.id || null}
        sourceCardLabel="Aadhaar Verification"
        onSuccess={() => onActionComplete?.()}
      />
    </div>
  );
}
