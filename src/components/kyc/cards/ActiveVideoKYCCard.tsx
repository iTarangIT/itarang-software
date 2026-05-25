"use client";

import { useMemo, useState } from "react";

interface VideoFaceMatchResult {
  originalImage?: string;
  results?: { matchScore?: number; covariance?: number };
  finalMatchImage?: string;
}

interface ActiveLivenessResults {
  videoFaceMatchResults?: VideoFaceMatchResult[];
  audioMatchResults?: { matchScore?: number };
  staticRisk?: string | boolean;
  prerecordedRisk?: string | boolean;
  liveliness?: string;
  geoLocation?: { latitude?: string; longitude?: string };
}

interface ActiveVideoKYCCardProps {
  leadId: string;
  applicant?: "primary" | "co_borrower";
  existingVerification?: {
    id: string;
    status: string;
    adminAction?: string | null;
    adminActionNotes?: string | null;
    matchScore?: string | null;
    apiResponse?: Record<string, unknown> | null;
    submittedAt?: string | null;
    completedAt?: string | null;
    failedReason?: string | null;
  } | null;
  onActionComplete?: () => void;
}

type CardStatus =
  | "pending"
  | "awaiting_customer"
  | "admin_review_pending"
  | "success"
  | "failed";

function deriveCardStatus(v: ActiveVideoKYCCardProps["existingVerification"]): CardStatus {
  if (!v) return "pending";
  if (v.adminAction === "accepted") return "success";
  if (v.adminAction === "rejected") return "failed";
  const s = (v.status || "").toLowerCase();
  if (["verified", "success", "admin_verified", "manual_verified"].includes(s)) return "success";
  if (s === "admin_review_pending") return "admin_review_pending";
  if (s === "awaiting_customer" || s === "initiating") return "awaiting_customer";
  if (s === "failed" || s === "rejected") return "failed";
  return "pending";
}

function isTrueish(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return false;
}

export default function ActiveVideoKYCCard({
  leadId,
  applicant = "primary",
  existingVerification,
  onActionComplete,
}: ActiveVideoKYCCardProps) {
  const cardStatus = useMemo(() => deriveCardStatus(existingVerification), [existingVerification]);

  const results = useMemo<ActiveLivenessResults | null>(() => {
    const r = (existingVerification?.apiResponse as { results?: ActiveLivenessResults } | null)?.results;
    return r ?? null;
  }, [existingVerification?.apiResponse]);

  const decentroTxnId = useMemo(() => {
    const t = (existingVerification?.apiResponse as { decentro_txn_id?: string } | null)?.decentro_txn_id;
    return typeof t === "string" ? t : null;
  }, [existingVerification?.apiResponse]);

  const matchRows = results?.videoFaceMatchResults ?? [];
  const audioScore = results?.audioMatchResults?.matchScore ?? null;
  const liveliness = (results?.liveliness ?? "").toString();
  const livelinessOk = liveliness.toLowerCase() === "yes";
  const staticRiskOn = isTrueish(results?.staticRisk);
  const prerecordedRiskOn = isTrueish(results?.prerecordedRisk);
  const geo = results?.geoLocation ?? null;

  const bestScore = useMemo(() => {
    if (existingVerification?.matchScore) {
      const n = parseFloat(String(existingVerification.matchScore));
      if (!isNaN(n)) return n;
    }
    let best = -1;
    for (const r of matchRows) {
      const s = r?.results?.matchScore;
      if (typeof s === "number" && s > best) best = s;
    }
    return best >= 0 ? best : null;
  }, [existingVerification?.matchScore, matchRows]);

  const [adminNotes, setAdminNotes] = useState("");
  const [actionLoading, setActionLoading] = useState<"" | "accept" | "reject">("");
  const [error, setError] = useState("");
  const [actionResult, setActionResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleAdminAction = async (action: "accept" | "reject") => {
    if (action === "reject" && !adminNotes.trim()) {
      setError("Please provide rejection reason in admin notes");
      return;
    }
    if (!existingVerification?.id) {
      setError("Verification record missing — ask the dealer to send the SMS first.");
      return;
    }
    setActionLoading(action);
    setError("");
    setActionResult(null);
    try {
      const res = await fetch(
        `/api/admin/kyc/${leadId}/verification/${existingVerification.id}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            notes: adminNotes,
            rejection_reason: action === "reject" ? adminNotes : undefined,
          }),
        },
      );
      const data = await res.json();
      if (data.success) {
        setActionResult({
          success: true,
          message: action === "accept" ? "Video KYC accepted successfully" : "Video KYC rejected",
        });
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

  const statusConfig: Record<CardStatus, { bg: string; label: string }> = {
    pending: { bg: "bg-gray-100 text-gray-600", label: "Not Sent" },
    awaiting_customer: { bg: "bg-blue-100 text-blue-700", label: "Awaiting Customer" },
    admin_review_pending: { bg: "bg-amber-100 text-amber-700", label: "Awaiting Review" },
    success: { bg: "bg-green-100 text-green-700", label: "Verified" },
    failed: { bg: "bg-red-100 text-red-700", label: "Failed" },
  };

  const adminBadge =
    existingVerification?.adminAction === "accepted"
      ? { bg: "bg-green-100 text-green-700", label: "Accepted" }
      : existingVerification?.adminAction === "rejected"
        ? { bg: "bg-red-100 text-red-700", label: "Rejected" }
        : null;
  const badge = adminBadge ?? statusConfig[cardStatus];

  const scoreTone = (score: number | null) =>
    score === null
      ? "text-gray-400"
      : score >= 80
        ? "text-emerald-600"
        : score >= 50
          ? "text-amber-600"
          : "text-red-600";

  const chipTone = (good: boolean) =>
    good
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : "bg-red-50 text-red-700 border-red-200";

  return (
    <div className="border border-gray-200 rounded-xl bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-purple-50 to-white">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-purple-600 flex items-center justify-center text-white font-bold text-sm">V</div>
          <div>
            <h3 className="text-base font-semibold text-gray-900">Video KYC</h3>
            <p className="text-xs text-gray-500">Decentro Active Liveness {applicant === "co_borrower" ? "· Co-borrower" : ""}</p>
          </div>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${badge.bg}`}>{badge.label}</span>
      </div>

      <div className="p-5 space-y-4">
        {cardStatus === "pending" && (
          <div className="bg-gray-50 border border-dashed border-gray-200 rounded-lg p-6 text-center">
            <p className="text-sm text-gray-500">No Video KYC session yet.</p>
            <p className="text-xs text-gray-400 mt-1">The dealer needs to send the customer the Decentro SMS link from their KYC page.</p>
          </div>
        )}

        {cardStatus === "awaiting_customer" && (
          <div className="bg-blue-50/60 border border-blue-100 rounded-lg p-4 text-sm text-blue-900">
            <p className="font-semibold mb-0.5">Waiting for customer</p>
            <p className="text-xs text-blue-700/80">SMS has been sent. Results will appear here once the customer finishes the Decentro session.</p>
          </div>
        )}

        {(cardStatus === "admin_review_pending" || cardStatus === "success" || cardStatus === "failed") && (
          <>
            {/* Risk + liveliness chips */}
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-semibold ${chipTone(livelinessOk)}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${livelinessOk ? "bg-emerald-500" : "bg-red-500"}`} />
                Liveliness: {liveliness || "—"}
              </span>
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-semibold ${chipTone(!staticRiskOn)}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${!staticRiskOn ? "bg-emerald-500" : "bg-red-500"}`} />
                Static risk: {staticRiskOn ? "true" : "false"}
              </span>
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-semibold ${chipTone(!prerecordedRiskOn)}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${!prerecordedRiskOn ? "bg-emerald-500" : "bg-red-500"}`} />
                Prerecorded risk: {prerecordedRiskOn ? "true" : "false"}
              </span>
            </div>

            {/* Face match table */}
            {matchRows.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-2">Face match against KYC images</p>
                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500 uppercase">Original</th>
                        <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500 uppercase">Match from video</th>
                        <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500 uppercase">Match score</th>
                        <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500 uppercase">Covariance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {matchRows.map((row, i) => {
                        const score = row?.results?.matchScore ?? null;
                        const cov = row?.results?.covariance ?? null;
                        return (
                          <tr key={i}>
                            <td className="px-3 py-2">
                              {row.originalImage ? (
                                <a href={row.originalImage} target="_blank" rel="noopener noreferrer">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={row.originalImage} alt="original" className="w-14 h-14 object-cover rounded border border-gray-200" />
                                </a>
                              ) : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-3 py-2">
                              {row.finalMatchImage ? (
                                <a href={row.finalMatchImage} target="_blank" rel="noopener noreferrer">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={row.finalMatchImage} alt="match" className="w-14 h-14 object-cover rounded border border-gray-200" />
                                </a>
                              ) : <span className="text-gray-300">—</span>}
                            </td>
                            <td className={`px-3 py-2 font-bold ${scoreTone(score)}`}>
                              {score === null ? "—" : `${score.toFixed(1)}`}
                            </td>
                            <td className="px-3 py-2 text-gray-600">
                              {cov === null ? "—" : cov.toFixed(1)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1">Best face-match</p>
                <p className={`font-bold text-base ${scoreTone(bestScore)}`}>
                  {bestScore === null ? "—" : `${bestScore.toFixed(1)}`}
                </p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1">Audio match</p>
                <p className={`font-bold text-base ${scoreTone(audioScore)}`}>
                  {audioScore === null ? "—" : `${audioScore.toFixed(1)}`}
                </p>
              </div>
            </div>

            {(geo?.latitude || geo?.longitude) && (
              <div className="bg-gray-50 rounded-lg p-3 text-xs text-gray-600">
                <span className="text-gray-400 uppercase font-semibold tracking-wide">Geolocation: </span>
                {geo?.latitude ?? "—"}, {geo?.longitude ?? "—"}
              </div>
            )}

            {decentroTxnId && (
              <p className="text-[10px] text-gray-400 font-mono">Decentro txn: {decentroTxnId}</p>
            )}

            {existingVerification?.failedReason && cardStatus === "failed" && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
                <p className="font-semibold mb-0.5">Failed reason</p>
                <p>{existingVerification.failedReason}</p>
              </div>
            )}

            <div className="bg-amber-50/60 border border-amber-100 rounded-lg p-3 text-xs text-amber-800 leading-relaxed">
              <p className="font-semibold mb-0.5">Reviewer checklist</p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>The matched faces clearly belong to the customer in the KYC documents.</li>
                <li>Liveliness is &quot;yes&quot; and both risk flags are &quot;false&quot;.</li>
                <li>Geolocation looks plausible for the customer&apos;s address.</li>
              </ul>
            </div>
          </>
        )}

        <div className="space-y-3 pt-4 border-t border-gray-200">
          {(existingVerification?.adminAction || actionResult) && (
            <div
              className={`rounded-lg p-3 text-sm font-medium flex items-center gap-2 ${
                existingVerification?.adminAction === "accepted" || actionResult?.success
                  ? "bg-green-50 border border-green-200 text-green-700"
                  : "bg-red-50 border border-red-200 text-red-700"
              }`}
            >
              {actionResult?.message || `Video KYC ${existingVerification?.adminAction} by admin.`}
            </div>
          )}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Admin Notes</label>
            <textarea
              value={adminNotes}
              onChange={(e) => setAdminNotes(e.target.value)}
              rows={2}
              placeholder="Add review remarks (required for reject)..."
              className="w-full mt-1.5 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 resize-none"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handleAdminAction("accept")}
              disabled={!!actionLoading || !existingVerification?.id || cardStatus === "pending" || cardStatus === "awaiting_customer"}
              className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              {actionLoading === "accept" ? "Accepting..." : "Accept"}
            </button>
            <button
              onClick={() => handleAdminAction("reject")}
              disabled={!!actionLoading || !existingVerification?.id || cardStatus === "pending" || cardStatus === "awaiting_customer"}
              className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              {actionLoading === "reject" ? "Rejecting..." : "Reject"}
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">{error}</div>
        )}
      </div>
    </div>
  );
}
