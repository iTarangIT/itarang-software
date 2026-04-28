"use client";

import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileText,
  Loader2,
  Sparkles,
} from "lucide-react";

export type CorrectionRoundItem = {
  id: string;
  kind: "field" | "document";
  key: string;
  label: string;
  previousValue: string | null;
  newValue: string | null;
  previousDocument: {
    id?: string;
    fileName?: string | null;
    fileUrl?: string | null;
    uploadedAt?: string | null;
  } | null;
  newDocument: {
    id?: string;
    fileName?: string | null;
    fileUrl?: string | null;
    uploadedAt?: string | null;
  } | null;
};

export type CorrectionRound = {
  id: string;
  roundNumber: number;
  status: "pending" | "submitted" | "applied" | "superseded" | string;
  remarks: string;
  dealerNote?: string | null;
  createdAt: string;
  dealerSubmittedAt?: string | null;
  appliedAt?: string | null;
  tokenExpiresAt?: string | null;
  items: CorrectionRoundItem[];
};

type Props = {
  dealerId: string;
  round: CorrectionRound;
  onApplied: () => void;
};

function formatDate(value?: string | null) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function StatusPill({ status }: { status: CorrectionRound["status"] }) {
  if (status === "submitted") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
        <Sparkles className="h-3.5 w-3.5" />
        Awaiting your review
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
        <Clock3 className="h-3.5 w-3.5" />
        Awaiting dealer
      </span>
    );
  }
  if (status === "applied") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Applied
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
      {status}
    </span>
  );
}

export default function CorrectionResponsePanel({ dealerId, round, onApplied }: Props) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fieldItems = round.items.filter((it) => it.kind === "field");
  const docItems = round.items.filter((it) => it.kind === "document");

  const isSubmitted = round.status === "submitted";

  const handleApply = async () => {
    if (!isSubmitted || applying) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/dealer-verifications/${dealerId}/apply-correction`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roundId: round.id }),
        },
      );
      let json: any = null;
      try { json = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok || !json?.success) {
        setError(json?.message || `Apply failed (HTTP ${res.status})`);
        return;
      }
      onApplied();
    } catch (err: any) {
      setError(err?.message || "Something went wrong");
    } finally {
      setApplying(false);
    }
  };

  return (
    <section className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-[#173F63]/5 px-2.5 py-1 text-xs font-semibold text-[#173F63]">
              Round #{round.roundNumber}
            </span>
            <StatusPill status={round.status} />
          </div>
          <h3 className="mt-2 text-lg font-semibold text-[#173F63]">
            Dealer's correction response
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            Review the dealer's resubmitted information. Click{" "}
            <span className="font-semibold text-slate-700">Update application</span>{" "}
            to merge these changes — the Approve button unlocks once applied.
          </p>
        </div>
        <div className="text-right text-xs text-slate-500">
          <p>Requested {formatDate(round.createdAt)}</p>
          {round.dealerSubmittedAt ? (
            <p className="mt-0.5">Submitted {formatDate(round.dealerSubmittedAt)}</p>
          ) : null}
        </div>
      </div>

      {/* Admin's original remark */}
      <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
          Reviewer remarks
        </p>
        <p className="mt-1 whitespace-pre-line text-sm text-amber-900">
          {round.remarks}
        </p>
      </div>

      {/* Dealer's note (if any) */}
      {round.dealerNote ? (
        <div className="mt-3 rounded-2xl border border-[#E3E8EF] bg-[#F9FBFD] p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Dealer's note
          </p>
          <p className="mt-1 whitespace-pre-line text-sm text-slate-700">
            {round.dealerNote}
          </p>
        </div>
      ) : null}

      {/* Field diff */}
      {fieldItems.length > 0 ? (
        <div className="mt-5 overflow-hidden rounded-2xl border border-[#E3E8EF]">
          <div className="bg-[#F4F8FC] px-4 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#173F63]">
              Information updates
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-white text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="border-b border-[#E3E8EF] px-4 py-2.5">Field</th>
                <th className="border-b border-[#E3E8EF] px-4 py-2.5">Previous</th>
                <th className="border-b border-[#E3E8EF] px-4 py-2.5">Submitted</th>
                <th className="border-b border-[#E3E8EF] px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {fieldItems.map((item) => {
                const changed =
                  (item.newValue ?? "") !== "" &&
                  item.newValue !== item.previousValue;
                return (
                  <tr key={item.id} className="bg-white">
                    <td className="border-b border-[#E3E8EF] px-4 py-3 align-top text-sm font-medium text-slate-700">
                      {item.label}
                    </td>
                    <td className="border-b border-[#E3E8EF] px-4 py-3 align-top text-sm text-slate-500">
                      {item.previousValue || <span className="italic text-slate-400">empty</span>}
                    </td>
                    <td className="border-b border-[#E3E8EF] px-4 py-3 align-top text-sm font-medium text-[#173F63]">
                      {item.newValue ? (
                        item.newValue
                      ) : (
                        <span className="italic text-slate-400">awaiting</span>
                      )}
                    </td>
                    <td className="border-b border-[#E3E8EF] px-4 py-3 align-top text-right">
                      {changed ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                          <ArrowRight className="h-3 w-3" />
                          Changed
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Documents diff */}
      {docItems.length > 0 ? (
        <div className="mt-5 rounded-2xl border border-[#E3E8EF]">
          <div className="bg-[#F4F8FC] px-4 py-2.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#173F63]">
              Document updates
            </p>
          </div>
          <ul className="divide-y divide-[#E3E8EF]">
            {docItems.map((item) => {
              const hasNew = !!item.newDocument?.fileUrl || !!item.newDocument?.fileName;
              return (
                <li
                  key={item.id}
                  className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center"
                >
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      {item.label} — previous
                    </p>
                    {item.previousDocument?.fileUrl ? (
                      <a
                        href={item.previousDocument.fileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:underline"
                      >
                        <FileText className="h-3.5 w-3.5" />
                        {item.previousDocument.fileName || "View previous file"}
                      </a>
                    ) : (
                      <p className="mt-1 text-sm italic text-slate-400">
                        No previous file
                      </p>
                    )}
                  </div>
                  <div className="hidden text-slate-300 sm:block">
                    <ArrowRight className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Re-uploaded
                    </p>
                    {hasNew ? (
                      <a
                        href={item.newDocument?.fileUrl || "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-1.5 text-sm font-semibold text-[#1F5C8F] hover:underline"
                      >
                        <FileText className="h-3.5 w-3.5" />
                        {item.newDocument?.fileName || "View re-uploaded file"}
                      </a>
                    ) : (
                      <p className="mt-1 text-sm italic text-slate-400">
                        Awaiting upload
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Footer / action */}
      {error ? (
        <div className="mt-5 flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          {error}
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          {isSubmitted
            ? "Once you click Update application, these values overwrite the originals and the Approve button will unlock."
            : round.status === "applied"
              ? "This round has already been applied to the application."
              : round.status === "pending"
                ? "Waiting for the dealer to submit. The magic link in their email is valid for 14 days."
                : null}
        </p>
        <button
          onClick={handleApply}
          disabled={!isSubmitted || applying}
          className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {applying ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
          Update application
        </button>
      </div>
    </section>
  );
}
