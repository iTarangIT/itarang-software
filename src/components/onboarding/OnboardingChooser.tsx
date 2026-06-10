"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useOnboardingStore } from "@/store/onboardingStore";

type MyApplication = {
  id: string;
  companyName: string | null;
  onboardingStatus: string | null;
  reviewStatus: string | null;
  draftStep: number | null;
  financeEnabled: boolean | null;
  dealerCode: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  submittedAt: string | null;
};

// Statuses that mean "not yet submitted" → the wizard can be resumed/edited.
const RESUMABLE = new Set(["draft", "in_progress", "correction_requested"]);

function statusBadge(status: string | null): { label: string; classes: string } {
  switch (status) {
    case "draft":
    case "in_progress":
      return { label: "Draft", classes: "bg-amber-50 text-amber-700 border-amber-200" };
    case "correction_requested":
      return {
        label: "Correction Requested",
        classes: "bg-orange-50 text-orange-700 border-orange-200",
      };
    case "approved":
      return { label: "Approved", classes: "bg-emerald-50 text-emerald-700 border-emerald-200" };
    case "rejected":
      return { label: "Rejected", classes: "bg-red-50 text-red-700 border-red-200" };
    case "submitted":
    case "pending_sales_head":
    case "under_review":
    case "agreement_in_progress":
    case "agreement_completed":
      return { label: "Submitted", classes: "bg-sky-50 text-sky-700 border-sky-200" };
    default:
      return {
        label: status ? status.replace(/_/g, " ") : "Unknown",
        classes: "bg-slate-50 text-slate-600 border-slate-200",
      };
  }
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function OnboardingChooser({
  onStartNew,
}: {
  onStartNew: () => void;
}) {
  const router = useRouter();
  const reset = useOnboardingStore((s) => s.reset);
  const [view, setView] = useState<"choose" | "drafts">("choose");
  const [apps, setApps] = useState<MyApplication[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  const loadDrafts = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnauthorized(false);
    try {
      const res = await fetch("/api/dealer-onboarding/my", { cache: "no-store" });
      if (res.status === 401) {
        setUnauthorized(true);
        return;
      }
      const json = await res.json();
      if (json?.success && Array.isArray(json.applications)) {
        setApps(json.applications as MyApplication[]);
      } else {
        setError(json?.message || "Could not load your onboardings.");
      }
    } catch {
      setError("Could not load your onboardings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === "drafts") void loadDrafts();
  }, [view, loadDrafts]);

  const startNew = () => {
    reset();
    onStartNew();
  };

  const openApplication = (id: string) => {
    router.push(`/dealer-onboarding?applicationId=${encodeURIComponent(id)}`);
  };

  return (
    <div className="min-h-screen bg-[#F5F7FA]">
      <div className="border-b border-[#E3E8EF] bg-white px-5 md:px-10 py-6">
        <h1 className="text-3xl font-bold text-[#173F63]">Dealer Onboarding</h1>
        <p className="text-slate-500 mt-1">
          Start a new dealer onboarding or continue one you saved earlier.
        </p>
      </div>

      <div className="mx-auto max-w-5xl px-5 md:px-10 py-10">
        {view === "choose" ? (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {/* New Dealer Onboarding */}
            <button
              type="button"
              onClick={startNew}
              className="group flex flex-col items-start rounded-2xl border border-[#E3E8EF] bg-white p-8 text-left shadow-sm transition hover:border-[#173F63] hover:shadow-md"
            >
              <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[#173F63]/10 text-2xl">
                ＋
              </span>
              <span className="text-xl font-semibold text-[#173F63]">
                New Dealer Onboarding
              </span>
              <span className="mt-2 text-sm text-slate-500">
                Begin a fresh onboarding with a blank form, from step one.
              </span>
              <span className="mt-6 text-sm font-medium text-[#173F63] group-hover:underline">
                Start now →
              </span>
            </button>

            {/* My Drafts */}
            <button
              type="button"
              onClick={() => setView("drafts")}
              className="group flex flex-col items-start rounded-2xl border border-[#E3E8EF] bg-white p-8 text-left shadow-sm transition hover:border-[#173F63] hover:shadow-md"
            >
              <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[#173F63]/10 text-2xl">
                🗂
              </span>
              <span className="text-xl font-semibold text-[#173F63]">My Drafts</span>
              <span className="mt-2 text-sm text-slate-500">
                Continue a saved onboarding, or see the status of ones you submitted.
              </span>
              <span className="mt-6 text-sm font-medium text-[#173F63] group-hover:underline">
                View list →
              </span>
            </button>
          </div>
        ) : (
          <div>
            <div className="mb-6 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setView("choose")}
                className="text-sm font-medium text-slate-500 hover:text-[#173F63]"
              >
                ← Back
              </button>
              <button
                type="button"
                onClick={startNew}
                className="rounded-lg bg-[#173F63] px-4 py-2 text-sm font-semibold text-white hover:bg-[#102d47]"
              >
                ＋ New Dealer Onboarding
              </button>
            </div>

            <div className="rounded-2xl border border-[#E3E8EF] bg-white shadow-sm">
              <div className="border-b border-[#E3E8EF] px-6 py-4">
                <h2 className="text-lg font-semibold text-[#173F63]">My Drafts</h2>
              </div>

              {loading ? (
                <div className="px-6 py-12 text-center text-slate-500">Loading…</div>
              ) : unauthorized ? (
                <div className="px-6 py-12 text-center text-slate-600">
                  <p className="font-medium text-[#173F63]">
                    Please sign in to see your saved onboardings.
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    Drafts are saved to your account. You can still start a new
                    onboarding here — it will be kept in this browser until you
                    sign in.
                  </p>
                  <a
                    href="/login"
                    className="mt-4 inline-block rounded-lg bg-[#173F63] px-4 py-2 text-sm font-semibold text-white hover:bg-[#102d47]"
                  >
                    Sign in
                  </a>
                </div>
              ) : error ? (
                <div className="px-6 py-12 text-center text-red-600">
                  {error}{" "}
                  <button
                    type="button"
                    onClick={loadDrafts}
                    className="font-medium underline"
                  >
                    Retry
                  </button>
                </div>
              ) : apps.length === 0 ? (
                <div className="px-6 py-12 text-center text-slate-500">
                  No saved onboardings yet.{" "}
                  <button
                    type="button"
                    onClick={startNew}
                    className="font-medium text-[#173F63] underline"
                  >
                    Start a new one
                  </button>
                  .
                </div>
              ) : (
                <ul className="divide-y divide-[#EEF2F6]">
                  {apps.map((app) => {
                    const badge = statusBadge(app.onboardingStatus);
                    const resumable = RESUMABLE.has(app.onboardingStatus ?? "");
                    return (
                      <li
                        key={app.id}
                        className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="truncate font-medium text-[#173F63]">
                              {app.companyName || "Unnamed dealer"}
                            </p>
                            <span
                              className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${badge.classes}`}
                            >
                              {badge.label}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-slate-500">
                            {resumable && app.draftStep
                              ? `Step ${app.draftStep} of 6 · `
                              : ""}
                            {app.submittedAt
                              ? `Submitted ${formatWhen(app.submittedAt)}`
                              : app.updatedAt
                                ? `Last saved ${formatWhen(app.updatedAt)}`
                                : ""}
                          </p>
                        </div>

                        {resumable ? (
                          <button
                            type="button"
                            onClick={() => openApplication(app.id)}
                            className="shrink-0 rounded-lg bg-[#173F63] px-4 py-2 text-sm font-semibold text-white hover:bg-[#102d47]"
                          >
                            Continue →
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openApplication(app.id)}
                            className="shrink-0 rounded-lg border border-[#E3E8EF] px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                          >
                            View
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
