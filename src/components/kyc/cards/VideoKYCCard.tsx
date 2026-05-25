"use client";

import { useMemo, useState } from "react";

interface VideoKYCCardProps {
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
  | "admin_review_pending"
  | "success"
  | "failed"
  | "expired";

function deriveCardStatus(v: VideoKYCCardProps["existingVerification"]): CardStatus {
  if (!v) return "pending";
  if (v.adminAction === "accepted") return "success";
  if (v.adminAction === "rejected") return "failed";
  const s = (v.status || "").toLowerCase();
  if (["verified", "success", "admin_verified", "manual_verified"].includes(s)) return "success";
  if (s === "admin_review_pending") return "admin_review_pending";
  if (s === "failed" || s === "rejected") return "failed";
  if (s === "expired") return "expired";
  return "pending";
}

function extractVideoUrl(apiResponse?: Record<string, unknown> | null): string | null {
  if (!apiResponse) return null;
  const direct = apiResponse.video_url;
  if (typeof direct === "string" && direct.length > 0) return direct;
  // Some shapes nest the URL inside data.video_url — defensive lookup.
  const data = apiResponse.data as Record<string, unknown> | undefined;
  const nested = data?.video_url;
  if (typeof nested === "string" && nested.length > 0) return nested;
  return null;
}

function extractConfidence(
  matchScore?: string | null,
  apiResponse?: Record<string, unknown> | null,
): number | null {
  // match_score is stored as 0-100 (scaled) in the route. Prefer it.
  if (matchScore !== null && matchScore !== undefined && matchScore !== "") {
    const n = parseFloat(String(matchScore));
    if (!isNaN(n)) return n;
  }
  // Fallback: read Decentro raw confidence (0.0-1.0) and scale.
  const decentro = apiResponse?.decentro as { data?: { confidence?: string | number } } | undefined;
  const raw = decentro?.data?.confidence;
  if (typeof raw === "number") return raw * 100;
  if (typeof raw === "string") {
    const n = parseFloat(raw);
    if (!isNaN(n)) return n * 100;
  }
  return null;
}

export default function VideoKYCCard({
  leadId,
  applicant = "primary",
  existingVerification,
  onActionComplete,
}: VideoKYCCardProps) {
  const cardStatus = useMemo(() => deriveCardStatus(existingVerification), [existingVerification]);
  const videoUrl = useMemo(() => extractVideoUrl(existingVerification?.apiResponse), [existingVerification?.apiResponse]);
  const confidence = useMemo(
    () => extractConfidence(existingVerification?.matchScore, existingVerification?.apiResponse),
    [existingVerification?.matchScore, existingVerification?.apiResponse],
  );

  const decentroMessage = useMemo(() => {
    const d = existingVerification?.apiResponse?.decentro as { message?: string; data?: { status?: string } } | undefined;
    return d?.message || (d?.data?.status ? `Liveness: ${d.data.status}` : null);
  }, [existingVerification?.apiResponse]);

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
      setError("Verification record missing — ask the dealer to record the video first.");
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
          message:
            action === "accept"
              ? "Video KYC accepted successfully"
              : "Video KYC rejected — dealer can re-record",
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
    pending: { bg: "bg-gray-100 text-gray-600", label: "Not Recorded" },
    admin_review_pending: { bg: "bg-amber-100 text-amber-700", label: "Awaiting Review" },
    success: { bg: "bg-green-100 text-green-700", label: "Verified" },
    failed: { bg: "bg-red-100 text-red-700", label: "Failed" },
    expired: { bg: "bg-orange-100 text-orange-700", label: "Expired" },
  };

  const adminBadge =
    existingVerification?.adminAction === "accepted"
      ? { bg: "bg-green-100 text-green-700", label: "Accepted" }
      : existingVerification?.adminAction === "rejected"
        ? { bg: "bg-red-100 text-red-700", label: "Rejected" }
        : null;
  const badge = adminBadge ?? statusConfig[cardStatus];

  const confidenceTone =
    confidence === null
      ? "text-gray-400"
      : confidence >= 80
        ? "text-emerald-600"
        : confidence >= 50
          ? "text-amber-600"
          : "text-red-600";

  return (
    <div className="border border-gray-200 rounded-xl bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-purple-50 to-white">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-purple-600 flex items-center justify-center text-white font-bold text-sm">V</div>
          <div>
            <h3 className="text-base font-semibold text-gray-900">Video KYC</h3>
            <p className="text-xs text-gray-500">Decentro Passive Liveness {applicant === "co_borrower" ? "· Co-borrower" : ""}</p>
          </div>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${badge.bg}`}>{badge.label}</span>
      </div>

      <div className="p-5 space-y-4">
        {/* No recording yet */}
        {cardStatus === "pending" && (
          <div className="bg-gray-50 border border-dashed border-gray-200 rounded-lg p-6 text-center">
            <p className="text-sm text-gray-500">No video recorded yet.</p>
            <p className="text-xs text-gray-400 mt-1">
              The dealer must capture a short selfie video on the dealer-portal KYC page before admin review is possible.
            </p>
          </div>
        )}

        {/* Recording on file */}
        {cardStatus !== "pending" && (
          <>
            {videoUrl ? (
              <div className="rounded-lg overflow-hidden border border-gray-200 bg-black aspect-video">
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video
                  src={videoUrl}
                  controls
                  playsInline
                  preload="metadata"
                  className="w-full h-full object-contain"
                />
              </div>
            ) : (
              <div className="bg-gray-50 border border-dashed border-gray-200 rounded-lg p-4 text-center">
                <p className="text-sm text-gray-500">Recording file is missing or expired.</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1">Liveness Confidence</p>
                <p className={`font-bold text-base ${confidenceTone}`}>
                  {confidence === null ? "—" : `${confidence.toFixed(1)}%`}
                </p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1">Captured</p>
                <p className="font-medium text-gray-800 text-xs">
                  {existingVerification?.completedAt
                    ? new Date(existingVerification.completedAt).toLocaleString()
                    : existingVerification?.submittedAt
                      ? new Date(existingVerification.submittedAt).toLocaleString()
                      : "—"}
                </p>
              </div>
            </div>

            {decentroMessage && (
              <div className="bg-purple-50/60 border border-purple-100 rounded-lg p-3 text-xs text-purple-900">
                <p className="font-semibold mb-0.5">Decentro response</p>
                <p>{decentroMessage}</p>
              </div>
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
                <li>The face on camera matches the customer&apos;s Aadhaar / PAN photo.</li>
                <li>The customer appears live (not a still photo or recorded playback).</li>
                <li>Lighting and framing are sufficient to identify the person.</li>
              </ul>
            </div>
          </>
        )}

        {/* Admin Actions */}
        <div className="space-y-3 pt-4 border-t border-gray-200">
          {(existingVerification?.adminAction || actionResult) && (
            <div
              className={`rounded-lg p-3 text-sm font-medium flex items-center gap-2 ${
                existingVerification?.adminAction === "accepted" || actionResult?.success
                  ? "bg-green-50 border border-green-200 text-green-700"
                  : "bg-red-50 border border-red-200 text-red-700"
              }`}
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                {existingVerification?.adminAction === "accepted" || actionResult?.message.includes("accepted") ? (
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                    clipRule="evenodd"
                  />
                ) : (
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                )}
              </svg>
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
              disabled={!!actionLoading || !existingVerification?.id || cardStatus === "pending"}
              className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              {actionLoading === "accept" ? "Accepting..." : "Accept"}
            </button>
            <button
              onClick={() => handleAdminAction("reject")}
              disabled={!!actionLoading || !existingVerification?.id || cardStatus === "pending"}
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
