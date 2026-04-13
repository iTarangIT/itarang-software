"use client";

import Image from "next/image";
import { useState } from "react";

import RequestMoreDocsModal from "./RequestMoreDocsModal";

// BRD §2.9.3 "Panel 2 — Supporting Documents Review" — rendered on the admin
// case-review screen whenever the lead has any otherDocumentRequests rows.
// Each row displays admin's original request reason, file preview, an Admin
// Notes field, and a 3-button action block (Approve / Reject / Request Docs).

export type SupportingDoc = {
  id: string;
  docFor: "primary" | "co_borrower";
  docLabel: string;
  docKey: string;
  isRequired: boolean;
  fileUrl: string | null;
  uploadStatus:
    | "not_uploaded"
    | "uploaded"
    | "rejected"
    | "verified"
    | string;
  rejectionReason: string | null;
  requestedAt: string | null;
  uploadedAt: string | null;
  reviewedAt: string | null;
  uploadToken: string | null;
  tokenExpiresAt: string | null;
};

interface Props {
  leadId: string;
  docs: SupportingDoc[];
  onRefresh: () => void;
}

function fmt(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SupportingDocsPanel({
  leadId,
  docs,
  onRefresh,
}: Props) {
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [rejectionDrafts, setRejectionDrafts] = useState<
    Record<string, string>
  >({});
  const [loadingId, setLoadingId] = useState("");
  const [error, setError] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [moreDocsFor, setMoreDocsFor] = useState<SupportingDoc | null>(null);

  if (docs.length === 0) return null;

  const handleReview = async (
    doc: SupportingDoc,
    action: "approve" | "reject",
  ) => {
    const reason = rejectionDrafts[doc.id]?.trim() ?? "";
    if (action === "reject" && !reason) {
      setError("Rejection reason is required.");
      return;
    }
    setLoadingId(`${doc.id}:${action}`);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/kyc/${leadId}/supporting-docs/${doc.id}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            note: noteDrafts[doc.id] ?? "",
            rejection_reason: action === "reject" ? reason : undefined,
          }),
        },
      );
      const data = await res.json();
      if (!data.success) {
        setError(data.error?.message ?? "Review failed");
        return;
      }
      onRefresh();
    } catch {
      setError("Network error");
    } finally {
      setLoadingId("");
    }
  };

  const copyLink = (doc: SupportingDoc) => {
    if (!doc.uploadToken) return;
    const base = typeof window !== "undefined" ? window.location.origin : "";
    const url = `${base}/upload-docs/${leadId}/${doc.id}/${doc.uploadToken}`;
    navigator.clipboard.writeText(url).catch(() => {});
  };

  const statusBadge = (status: string) => {
    if (status === "verified")
      return "bg-green-100 text-green-700 ring-green-600/20";
    if (status === "rejected") return "bg-red-100 text-red-700 ring-red-600/20";
    if (status === "uploaded")
      return "bg-blue-100 text-blue-700 ring-blue-600/20";
    return "bg-amber-100 text-amber-800 ring-amber-600/20";
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-amber-50 to-white flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            Supporting Documents (Step 3)
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {docs.length} request{docs.length === 1 ? "" : "s"} — BRD §2.9.3
            Panel 2
          </p>
        </div>
      </div>

      <div className="divide-y divide-gray-100">
        {docs.map((d) => {
          const note = noteDrafts[d.id] ?? "";
          const reason = rejectionDrafts[d.id] ?? "";
          const isFinal =
            d.uploadStatus === "verified" || d.uploadStatus === "rejected";
          const hasFile = !!d.fileUrl;

          return (
            <div key={d.id} className="p-5">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-sm text-gray-900">
                      {d.docLabel}
                    </p>
                    {d.isRequired && (
                      <span className="text-red-500 text-xs font-semibold">
                        *
                      </span>
                    )}
                    <span
                      className={`px-2 py-0.5 rounded-full text-[11px] font-medium ring-1 ring-inset capitalize ${statusBadge(d.uploadStatus)}`}
                    >
                      {d.uploadStatus.replace(/_/g, " ")}
                    </span>
                    <span className="text-[11px] text-gray-500">
                      For:{" "}
                      {d.docFor === "co_borrower"
                        ? "Co-Borrower"
                        : "Primary"}
                    </span>
                  </div>
                  {d.rejectionReason && d.uploadStatus !== "rejected" && (
                    <p className="text-xs text-gray-600 mt-1">
                      Reason: {d.rejectionReason}
                    </p>
                  )}
                  <p className="text-[11px] text-gray-400 mt-1">
                    Requested {fmt(d.requestedAt)}
                    {d.uploadedAt ? ` · Uploaded ${fmt(d.uploadedAt)}` : ""}
                    {d.reviewedAt ? ` · Reviewed ${fmt(d.reviewedAt)}` : ""}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {hasFile && (
                    <button
                      type="button"
                      onClick={() => setLightbox(d.fileUrl)}
                      className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium"
                    >
                      View
                    </button>
                  )}
                  {d.uploadToken && !hasFile && (
                    <button
                      type="button"
                      onClick={() => copyLink(d)}
                      className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium"
                    >
                      Copy upload link
                    </button>
                  )}
                </div>
              </div>

              {d.uploadStatus === "rejected" && d.rejectionReason && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700 mb-3">
                  Rejected: {d.rejectionReason}
                </div>
              )}

              {!isFinal && hasFile && (
                <div className="space-y-3">
                  <div>
                    <label className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                      Admin Notes (internal)
                    </label>
                    <textarea
                      value={note}
                      onChange={(e) =>
                        setNoteDrafts((p) => ({ ...p, [d.id]: e.target.value }))
                      }
                      rows={2}
                      placeholder="Optional internal note…"
                      className="w-full mt-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                      Rejection Reason (required to reject)
                    </label>
                    <textarea
                      value={reason}
                      onChange={(e) =>
                        setRejectionDrafts((p) => ({
                          ...p,
                          [d.id]: e.target.value,
                        }))
                      }
                      rows={2}
                      placeholder="e.g. Pincode still unreadable"
                      className="w-full mt-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-red-500 focus:border-red-500"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleReview(d, "approve")}
                      disabled={loadingId.startsWith(d.id)}
                      className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                    >
                      {loadingId === `${d.id}:approve` ? "…" : "Approve"}
                    </button>
                    <button
                      onClick={() => handleReview(d, "reject")}
                      disabled={loadingId.startsWith(d.id)}
                      className="flex-1 bg-red-600 hover:bg-red-700 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                    >
                      {loadingId === `${d.id}:reject` ? "…" : "Reject"}
                    </button>
                    <button
                      onClick={() => setMoreDocsFor(d)}
                      disabled={loadingId.startsWith(d.id)}
                      className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                    >
                      Request Docs
                    </button>
                  </div>
                </div>
              )}

              {!hasFile && d.uploadStatus === "not_uploaded" && (
                <div className="text-xs text-gray-500 italic">
                  Awaiting upload from dealer / customer…
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <div className="px-5 py-3 bg-red-50 border-t border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8"
          onClick={() => setLightbox(null)}
        >
          <div
            className="relative max-w-4xl max-h-full"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setLightbox(null)}
              className="absolute -top-3 -right-3 w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center text-gray-600"
              aria-label="Close"
            >
              ×
            </button>
            {lightbox.match(/\.pdf(\?|$)/i) ? (
              <iframe
                src={lightbox}
                className="w-[80vw] h-[80vh] bg-white rounded-lg"
                title="Supporting document"
              />
            ) : (
              <Image
                src={lightbox}
                alt="Supporting document"
                width={800}
                height={600}
                className="max-h-[80vh] w-auto rounded-lg shadow-2xl"
                unoptimized
              />
            )}
          </div>
        </div>
      )}

      <RequestMoreDocsModal
        open={!!moreDocsFor}
        onClose={() => setMoreDocsFor(null)}
        leadId={leadId}
        sourceVerificationId={moreDocsFor?.id ?? null}
        sourceCardLabel={
          moreDocsFor ? `Supporting Doc: ${moreDocsFor.docLabel}` : undefined
        }
        defaultDocFor={moreDocsFor?.docFor ?? "primary"}
        onSuccess={onRefresh}
      />
    </div>
  );
}
