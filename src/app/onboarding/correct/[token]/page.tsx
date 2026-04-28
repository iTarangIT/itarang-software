"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileText,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import FileUploadCard, {
  type UploadCardValue,
} from "@/components/onboarding/FileUploadCard";

type CorrectionItem = {
  id: string;
  kind: "field" | "document";
  key: string;
  label: string;
  previousValue: string | null;
  previousDocument: {
    fileName?: string | null;
    fileUrl?: string | null;
    uploadedAt?: string | null;
  } | null;
};

type CorrectionData = {
  applicationId: string;
  companyName: string;
  roundNumber: number;
  remarks: string;
  expiresAt: string | null;
  items: CorrectionItem[];
};

type LoadState =
  | { state: "loading" }
  | { state: "ready"; data: CorrectionData }
  | { state: "info"; message: string }
  | { state: "error"; message: string };

export default function DealerCorrectionPage() {
  const params = useParams();
  const token = (params?.token as string) || "";

  const [load, setLoad] = useState<LoadState>({ state: "loading" });
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [docValues, setDocValues] = useState<Record<string, UploadCardValue | null>>({});
  const [dealerNote, setDealerNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/onboarding/correct/${token}`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (cancelled) return;

        if (json?.success) {
          const data = json.data as CorrectionData;
          setLoad({ state: "ready", data });
          // Pre-fill fields with their previous values so the dealer can edit
          // in place rather than retyping unchanged context.
          const initialFields: Record<string, string> = {};
          for (const item of data.items) {
            if (item.kind === "field") {
              initialFields[item.key] = item.previousValue ?? "";
            }
          }
          setFieldValues(initialFields);
        } else if (json?.state) {
          setLoad({
            state: "info",
            message: json.message || "This correction link is no longer active.",
          });
        } else {
          setLoad({
            state: "error",
            message: json?.message || "Could not open correction form.",
          });
        }
      } catch (err: any) {
        if (!cancelled) {
          setLoad({
            state: "error",
            message: err?.message || "Could not open correction form.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const data = load.state === "ready" ? load.data : null;

  const fieldItems = useMemo(
    () => data?.items.filter((it) => it.kind === "field") ?? [],
    [data],
  );
  const docItems = useMemo(
    () => data?.items.filter((it) => it.kind === "document") ?? [],
    [data],
  );

  const completedFields = fieldItems.filter(
    (it) => (fieldValues[it.key] ?? "").trim().length > 0,
  ).length;
  const completedDocs = docItems.filter(
    (it) => docValues[it.key]?.verificationState === "verified",
  ).length;
  const totalRequired = fieldItems.length + docItems.length;
  const totalCompleted = completedFields + completedDocs;
  const allDone = totalRequired > 0 && totalCompleted === totalRequired;

  const handleSubmit = async () => {
    if (!data || !allDone || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const fieldUpdates: Record<string, string> = {};
      for (const item of fieldItems) {
        fieldUpdates[item.key] = (fieldValues[item.key] ?? "").trim();
      }
      const documentUpdates = docItems
        .map((item) => {
          const v = docValues[item.key];
          if (!v || v.verificationState !== "verified") return null;
          return {
            documentType: item.key,
            bucketName: v.bucketName ?? "dealer-documents",
            storagePath: v.storagePath ?? "",
            fileUrl: v.uploadedUrl ?? "",
            fileName: v.file?.name ?? "",
            mimeType: v.file?.type ?? null,
            fileSize: v.file?.size ?? null,
          };
        })
        .filter(Boolean);

      const res = await fetch(`/api/onboarding/correct/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fieldUpdates,
          documentUpdates,
          dealerNote: dealerNote.trim() || undefined,
        }),
      });
      let json: any = null;
      try { json = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok || !json?.success) {
        setSubmitError(json?.message || `Submit failed (HTTP ${res.status})`);
        return;
      }
      setSubmitted(true);
    } catch (err: any) {
      setSubmitError(err?.message || "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Render states ─────────────────────────────────────────────────────────

  if (load.state === "loading") {
    return (
      <Shell>
        <div className="rounded-3xl border border-[#E3E8EF] bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
          <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-[#1F5C8F]" />
          Loading correction form…
        </div>
      </Shell>
    );
  }

  if (load.state === "error") {
    return (
      <Shell>
        <div className="rounded-3xl border border-rose-200 bg-rose-50 p-8 text-center text-sm text-rose-700 shadow-sm">
          <AlertTriangle className="mx-auto mb-3 h-6 w-6" />
          {load.message}
        </div>
      </Shell>
    );
  }

  if (load.state === "info") {
    return (
      <Shell>
        <div className="rounded-3xl border border-[#E3E8EF] bg-white p-8 text-center shadow-sm">
          <ShieldCheck className="mx-auto mb-3 h-7 w-7 text-[#1F5C8F]" />
          <h2 className="text-lg font-semibold text-[#173F63]">
            Nothing to do here
          </h2>
          <p className="mt-2 text-sm text-slate-500">{load.message}</p>
        </div>
      </Shell>
    );
  }

  if (submitted) {
    return (
      <Shell>
        <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-8 text-center shadow-sm">
          <CheckCircle2 className="mx-auto mb-3 h-8 w-8 text-emerald-600" />
          <h2 className="text-lg font-semibold text-emerald-900">
            Corrections submitted
          </h2>
          <p className="mt-2 text-sm text-emerald-800">
            Thank you. The iTarang team has been notified and will review your
            updates shortly. You'll receive an email once your application is
            approved.
          </p>
        </div>
      </Shell>
    );
  }

  if (!data) return null;

  return (
    <Shell>
      <div className="space-y-5">
        {/* Header card */}
        <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[#1F5C8F]">
                Correction round #{data.roundNumber}
              </p>
              <h1 className="mt-1 text-xl font-semibold text-[#173F63]">
                Update your dealer onboarding
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                {data.companyName} · Application {data.applicationId.slice(0, 8)}…
              </p>
            </div>
            <div className="rounded-full border border-[#E3E8EF] bg-[#F4F8FC] px-3 py-1 text-xs font-semibold text-[#173F63]">
              {totalCompleted} of {totalRequired} ready
            </div>
          </div>

          {/* Reviewer remarks */}
          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
              Reviewer remarks
            </p>
            <p className="mt-1 whitespace-pre-line text-sm text-amber-900">
              {data.remarks}
            </p>
          </div>
        </div>

        {/* Fields */}
        {fieldItems.length > 0 ? (
          <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm">
            <h2 className="text-base font-semibold text-[#173F63]">
              Information to update
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Update the values flagged by the reviewer.
            </p>
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {fieldItems.map((item) => (
                <div key={item.id}>
                  <label className="block text-sm font-semibold text-[#173F63]">
                    {item.label}
                  </label>
                  {item.previousValue ? (
                    <p className="mt-0.5 text-xs text-slate-500">
                      Previous: <span className="font-medium text-slate-700">{item.previousValue}</span>
                    </p>
                  ) : null}
                  <input
                    type="text"
                    value={fieldValues[item.key] ?? ""}
                    onChange={(e) =>
                      setFieldValues((prev) => ({
                        ...prev,
                        [item.key]: e.target.value,
                      }))
                    }
                    className="mt-2 w-full rounded-2xl border border-[#E3E8EF] bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#1F5C8F]"
                  />
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Documents */}
        {docItems.length > 0 ? (
          <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm">
            <h2 className="text-base font-semibold text-[#173F63]">
              Documents to re-upload
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Upload a fresh copy for each document the reviewer flagged.
            </p>
            <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
              {docItems.map((item) => (
                <div
                  key={item.id}
                  className="rounded-2xl border border-[#E3E8EF] bg-[#F9FBFD] p-4"
                >
                  {item.previousDocument?.fileUrl ? (
                    <div className="mb-3 flex items-center gap-2 rounded-xl border border-[#E3E8EF] bg-white px-3 py-2 text-xs text-slate-500">
                      <FileText className="h-3.5 w-3.5 text-slate-400" />
                      <span className="font-medium text-slate-600">
                        Previous file:
                      </span>
                      <a
                        href={item.previousDocument.fileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate text-[#1F5C8F] hover:underline"
                      >
                        {item.previousDocument.fileName || "View previous"}
                      </a>
                    </div>
                  ) : null}
                  <FileUploadCard
                    label={item.label}
                    hint="Drag a fresh copy of this document"
                    value={docValues[item.key] ?? null}
                    onChange={(v) =>
                      setDocValues((prev) => ({ ...prev, [item.key]: v }))
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Optional dealer note */}
        <div className="rounded-3xl border border-[#E3E8EF] bg-white p-6 shadow-sm">
          <label className="block text-sm font-semibold text-[#173F63]">
            Anything to share with the reviewer? <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea
            value={dealerNote}
            onChange={(e) => setDealerNote(e.target.value)}
            placeholder="e.g. We've also updated the email address on the bank account, attached new GST certificate."
            className="mt-2 min-h-[100px] w-full rounded-2xl border border-[#E3E8EF] bg-white p-3 text-sm text-slate-900 outline-none transition focus:border-[#1F5C8F]"
          />
        </div>

        {submitError ? (
          <div className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            <AlertTriangle className="mt-0.5 h-4 w-4" />
            {submitError}
          </div>
        ) : null}

        {/* Sticky submit bar */}
        <div className="sticky bottom-4 rounded-3xl border border-[#E3E8EF] bg-white p-4 shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="h-2 w-40 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-[#1F5C8F] transition-all"
                  style={{
                    width: `${totalRequired === 0 ? 0 : (totalCompleted / totalRequired) * 100}%`,
                  }}
                />
              </div>
              <p className="text-xs text-slate-500">
                <span className="font-semibold text-slate-700">{totalCompleted}</span>{" "}
                of {totalRequired} items ready
              </p>
            </div>
            <button
              onClick={handleSubmit}
              disabled={!allDone || submitting}
              className="inline-flex items-center gap-2 rounded-2xl bg-[#173F63] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#0f2c47] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
              Submit corrections
            </button>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[#F4F8FC] px-4 py-8 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center gap-2">
          <div className="rounded-xl bg-[#173F63] px-3 py-2 text-sm font-bold text-white">
            iTarang
          </div>
          <p className="text-sm font-semibold text-[#173F63]">
            Dealer onboarding · Correction
          </p>
        </div>
        {children}
      </div>
    </main>
  );
}
