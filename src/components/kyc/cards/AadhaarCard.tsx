"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import ManualDecisionSection from "./ManualDecisionSection";
import RequestMoreDocsModal from "../step3/RequestMoreDocsModal";

interface AadhaarCardProps {
  leadId: string;
  leadName: string;
  phone: string;
  email?: string;
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

export default function AadhaarCard({
  leadId,
  leadName,
  phone,
  email,
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
  const [digilockerUrl, setDigilockerUrl] = useState("");
  const [adminNotes, setAdminNotes] = useState("");
  const [actionLoading, setActionLoading] = useState("");
  const [showMoreDocsModal, setShowMoreDocsModal] = useState(false);
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
      setDigiStatus("link_sent");
      setCardStatus("awaiting_consent");
    } catch {
      setError("Network error. Please try again.");
      setCardStatus("failed");
    } finally {
      setLoading(false);
    }
  };

  const handleAdminAction = async (action: "accept" | "reject" | "request_more_docs") => {
    const vid = existingVerification?.id;
    if (!vid) { setError("No verification record found. Please wait for document to be fetched."); return; }
    if (action === "reject" && !adminNotes.trim()) {
      setError("Please provide rejection reason in admin notes");
      return;
    }
    setActionLoading(action);
    setError("");
    try {
      const res = await fetch(`/api/admin/kyc/${leadId}/verification/${vid}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          notes: adminNotes,
          rejection_reason: action === "reject" ? adminNotes : undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (action === "accept") setCardStatus("success");
        else if (action === "reject") setCardStatus("failed");
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

            {/* Manual Override — skip DigiLocker when Aadhaar was verified offline */}
            {!existingVerification?.id && (
              <ManualDecisionSection
                leadId={leadId}
                verificationType="aadhaar"
                applicant={applicant}
                onActionComplete={onActionComplete}
              />
            )}
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
              <div className="bg-white border border-gray-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">DigiLocker Link (share with customer)</p>
                <div className="flex items-center gap-2">
                  <input type="text" readOnly value={digilockerUrl}
                    className="flex-1 text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 truncate" />
                  <button onClick={() => { navigator.clipboard.writeText(digilockerUrl); }}
                    className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded transition-colors whitespace-nowrap">
                    Copy
                  </button>
                  <a href={digilockerUrl} target="_blank" rel="noopener noreferrer"
                    className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors whitespace-nowrap">
                    Open
                  </a>
                </div>
              </div>
            )}
            {transactionId && <p className="text-xs text-gray-400">Transaction: {transactionId}</p>}
            <div className="flex gap-2">
              <button onClick={() => { setTransactionId(""); setDigiStatus("idle"); setCardStatus("pending"); setDigilockerUrl(""); setError(""); }}
                className="px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors">
                Resend Link
              </button>
              <button onClick={pollStatus}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors">
                Refresh
              </button>
            </div>
          </div>
        )}

        {/* Document Fetched / Success / Failed with results */}
        {(cardStatus === "document_fetched" || cardStatus === "success" || (cardStatus === "failed" && crossMatch)) && (
          <div className="space-y-4">
            {aadhaarData && (
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-3">Aadhaar Data (DigiLocker)</p>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {aadhaarData.name && <div><p className="text-xs text-gray-400">Name</p><p className="font-medium text-gray-800">{aadhaarData.name}</p></div>}
                  {aadhaarData.uid && <div><p className="text-xs text-gray-400">Aadhaar</p><p className="font-medium text-gray-800">XXXX-XXXX-{aadhaarData.uid.slice(-4)}</p></div>}
                  {aadhaarData.gender && <div><p className="text-xs text-gray-400">Gender</p><p className="font-medium text-gray-800">{aadhaarData.gender === "M" ? "Male" : aadhaarData.gender === "F" ? "Female" : aadhaarData.gender}</p></div>}
                  {aadhaarData.dob && <div><p className="text-xs text-gray-400">DOB</p><p className="font-medium text-gray-800">{aadhaarData.dob}</p></div>}
                  {aadhaarData.careof && <div className="col-span-2"><p className="text-xs text-gray-400">Father/Husband</p><p className="font-medium text-gray-800">{aadhaarData.careof}</p></div>}
                  {aadhaarData.address && <div className="col-span-2"><p className="text-xs text-gray-400">Address</p><p className="font-medium text-gray-800">{aadhaarData.address}</p></div>}
                </div>
              </div>
            )}

            {crossMatch && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide">Cross-Match Results</p>
                  <span className={`px-3 py-1 rounded-full text-xs font-semibold ${crossMatch.overallPass ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                    {crossMatch.overallPass ? "Pass" : "Fail"}
                  </span>
                </div>
                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="w-full text-sm min-w-[600px]">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">#</th>
                        <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Field</th>
                        <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Lead Data</th>
                        <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Aadhaar Data</th>
                        <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500">Match</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {crossMatch.fields.map((f, i) => {
                        const lead = f.leadValue || f.inputValue || null;
                        const aadhaar = f.aadhaarValue || f.documentValue || null;
                        const passed = f.pass ?? (f.matchResult === "strong" || f.matchResult === "moderate");
                        return (
                          <tr key={f.field} className="hover:bg-gray-50/50">
                            <td className="px-4 py-2 text-gray-400">{i + 1}</td>
                            <td className="px-4 py-2 font-medium text-gray-700 capitalize">{(f.label || f.field).replace(/_/g, " ")}</td>
                            <td className="px-4 py-2 text-gray-600 max-w-[160px] truncate">{lead || "—"}</td>
                            <td className="px-4 py-2 text-gray-600 max-w-[160px] truncate">{aadhaar || "—"}</td>
                            <td className="px-4 py-2">{getMatchBadge(f.similarity, f.threshold, passed)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {cardStatus === "document_fetched" && existingVerification?.id && (
              <div className="space-y-3 pt-3 border-t border-gray-100">
                <div>
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">Admin Notes</label>
                  <textarea value={adminNotes} onChange={(e) => setAdminNotes(e.target.value)} rows={2}
                    placeholder="Add verification remarks..."
                    className="w-full mt-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
                </div>
                <div className="flex gap-2">
                  <button onClick={() => handleAdminAction("accept")} disabled={!!actionLoading}
                    className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
                    {actionLoading === "accept" ? "..." : "Accept"}
                  </button>
                  <button onClick={() => handleAdminAction("reject")} disabled={!!actionLoading}
                    className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
                    {actionLoading === "reject" ? "..." : "Reject"}
                  </button>
                  <button onClick={() => setShowMoreDocsModal(true)} disabled={!!actionLoading}
                    className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
                    Request Docs
                  </button>
                </div>
              </div>
            )}

            {cardStatus === "success" && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-green-700 text-sm font-medium">
                Aadhaar verification accepted by admin.
              </div>
            )}
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
