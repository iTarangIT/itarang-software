"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  Building2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Eye,
  FileImage,
  FileText,
  Landmark,
  Loader2,
  Lock,
  MapPin,
  ShieldCheck,
  UserRound,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import type { ExistingApplicationView as Data, ExistingDocument } from "@/lib/onboarding/existingViewData";

// View-only page for an onboarding application that already exists (27 Nov).
// Nothing here can be downloaded: documents arrive as page images (PDFs are
// rasterised on the server) and are painted as CSS backgrounds under a
// watermark; right-click, drag, select, copy, save and print are turned off.
// When the 15 minutes run out the page asks for a new link and moves to it;
// the old URL stops working.

const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: "Draft — not submitted", tone: "bg-slate-100 text-slate-700 ring-slate-200" },
  submitted: { label: "Submitted · under review", tone: "bg-amber-50 text-amber-800 ring-amber-200" },
  under_review: { label: "Under review", tone: "bg-amber-50 text-amber-800 ring-amber-200" },
  correction_requested: { label: "Correction requested", tone: "bg-orange-50 text-orange-800 ring-orange-200" },
  rejected: { label: "Rejected", tone: "bg-rose-50 text-rose-700 ring-rose-200" },
  approved: { label: "Approved", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
};

const DOC_STATUS: Record<string, string> = {
  verified: "bg-emerald-50 text-emerald-700",
  approved: "bg-emerald-50 text-emerald-700",
  pending: "bg-slate-100 text-slate-600",
  rejected: "bg-rose-50 text-rose-700",
};

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";

const pretty = (v: string | null | undefined) =>
  v ? v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : null;

function Field({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-1 break-words text-[15px] font-medium text-slate-900 ${mono ? "font-mono tracking-wide" : ""}`}>
        {value && String(value).trim() ? value : "—"}
      </p>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(23,63,99,0.18)] sm:p-6">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#E8F1FA] to-[#D6E6F5] text-[#1F5C8F]">
          {icon}
        </span>
        <h2 className="text-lg font-semibold text-[#173F63]">{title}</h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function useCountdown(expiresAt: number) {
  const [left, setLeft] = useState(() => Math.max(0, expiresAt - Date.now()));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, expiresAt - Date.now())), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  return left;
}

export default function ExistingApplicationView({
  token,
  expiresAt,
  data,
}: {
  token: string;
  expiresAt: number;
  data: Data;
}) {
  const left = useCountdown(expiresAt);
  const expired = left <= 0;
  const [renewing, setRenewing] = useState(false);
  const [renewError, setRenewError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ExistingDocument | null>(null);
  const renewedRef = useRef(false);

  const mm = String(Math.floor(left / 60000)).padStart(2, "0");
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  const pct = Math.max(0, Math.min(100, (left / (15 * 60 * 1000)) * 100));
  const lowTime = left < 60_000;

  const renew = useCallback(async () => {
    setRenewing(true);
    setRenewError(null);
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
      // This browser can't renew (cookie gone) — reload: this URL now explains what to do.
      window.location.reload();
    } catch {
      setRenewError("Could not open a new link. Check your connection and try again.");
      setRenewing(false);
    }
  }, [token]);

  // 15 minutes are up: close any document and move to a new link.
  useEffect(() => {
    if (!expired || renewedRef.current) return;
    const t = setTimeout(() => {
      renewedRef.current = true;
      void renew();
    }, 0);
    return () => clearTimeout(t);
  }, [expired, renew]);

  // No saving, printing, copying or right-click on this page.
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    const keys = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && ["s", "p", "c", "u", "a"].includes(k)) e.preventDefault();
    };
    document.addEventListener("contextmenu", stop);
    document.addEventListener("dragstart", stop);
    document.addEventListener("copy", stop);
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("contextmenu", stop);
      document.removeEventListener("dragstart", stop);
      document.removeEventListener("copy", stop);
      document.removeEventListener("keydown", keys);
    };
  }, []);

  const status = STATUS[data.onboardingStatus] ?? { label: pretty(data.onboardingStatus) ?? "—", tone: STATUS.draft.tone };
  const canContinue = ["draft", "correction_requested", "rejected"].includes(data.onboardingStatus) && !data.isLocked;

  return (
    <div className="existing-view min-h-screen select-none bg-[#F4F7FB] [-webkit-touch-callout:none]">
      <style>{`@media print { .existing-view { display: none !important; } body::after { content: "This page cannot be printed."; display:block; padding:4rem; font: 16px system-ui; } }`}</style>

      {/* Hero */}
      <header className="relative overflow-hidden bg-gradient-to-br from-[#0F2E4A] via-[#173F63] to-[#1F5C8F] text-white">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 left-10 h-72 w-72 rounded-full bg-sky-400/20 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider ring-1 ring-white/20 backdrop-blur">
              <Lock className="h-3.5 w-3.5" /> View only
            </span>
            <div
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold ring-1 backdrop-blur ${
                lowTime ? "bg-rose-500/20 ring-rose-300/40" : "bg-white/10 ring-white/20"
              }`}
              title="This link closes when the timer ends. A new link is opened for you in this browser."
            >
              <Clock3 className="h-4 w-4" />
              <span className="tabular-nums">
                {mm}:{ss}
              </span>
              <span className="hidden font-normal text-white/70 sm:inline">left on this link</span>
            </div>
          </div>
          <h1 className="mt-6 text-3xl font-bold tracking-tight !text-white sm:text-4xl">{data.companyName || "Your application"}</h1>
          <p className="mt-2 max-w-2xl text-white/75">
            An application with these details is already with iTarang. Review what is on file below.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ring-1 ${status.tone}`}>
              <BadgeCheck className="h-4 w-4" /> {status.label}
            </span>
            {data.submittedAt && (
              <span className="rounded-full bg-white/10 px-3 py-1 text-sm text-white/85 ring-1 ring-white/15">
                Submitted {fmtDate(data.submittedAt)}
              </span>
            )}
            {data.gstNumber && (
              <span className="rounded-full bg-white/10 px-3 py-1 font-mono text-sm text-white/85 ring-1 ring-white/15">
                GST {data.gstNumber}
              </span>
            )}
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/10">
          <div
            className={`h-full transition-[width] duration-1000 ease-linear ${lowTime ? "bg-rose-400" : "bg-sky-300"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </header>

      <main className="relative mx-auto -mt-12 max-w-6xl px-4 pb-16 sm:px-6">
        {/* Security strip */}
        <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-emerald-100 bg-white/95 px-5 py-4 text-sm text-slate-700 shadow-lg shadow-slate-900/5 backdrop-blur">
          <span className="inline-flex items-center gap-2 font-semibold text-emerald-700">
            <ShieldCheck className="h-5 w-5" /> Private link
          </span>
          <span>Opens only in this browser</span>
          <span className="hidden h-4 w-px bg-slate-200 sm:block" />
          <span>Download, print and copy are turned off</span>
          <span className="hidden h-4 w-px bg-slate-200 sm:block" />
          <span>Link refreshes every 15 minutes</span>
        </div>

        {renewing || expired ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white px-6 py-20 text-center shadow-sm">
            {renewError ? (
              <>
                <p className="text-slate-700">{renewError}</p>
                <button
                  type="button"
                  onClick={() => void renew()}
                  className="mt-4 rounded-xl bg-[#1F5C8F] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#173F63]"
                >
                  Try again
                </button>
              </>
            ) : (
              <>
                <Loader2 className="h-8 w-8 animate-spin text-[#1F5C8F]" />
                <p className="mt-4 font-semibold text-[#173F63]">This link has expired</p>
                <p className="mt-1 text-sm text-slate-500">Opening a new secure link…</p>
              </>
            )}
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <Section icon={<Building2 className="h-5 w-5" />} title="Company">
                <Field label="Company name" value={data.companyName} />
                <Field label="Company type" value={pretty(data.companyType)} />
                <Field label="Dealer type" value={pretty(data.dealerType)} />
                <Field label="GST number" value={data.gstNumber} mono />
                <Field label="PAN" value={data.panNumber} mono />
                {data.cinNumber && <Field label="CIN" value={data.cinNumber} mono />}
              </Section>

              <Section icon={<MapPin className="h-5 w-5" />} title="Address">
                <div className="sm:col-span-2">
                  <Field label="Business address" value={data.address} />
                </div>
                <Field label="City / State / PIN" value={data.cityLine} />
              </Section>

              <Section icon={<UserRound className="h-5 w-5" />} title="Owner & contact">
                <Field label="Owner name" value={data.ownerName} />
                <Field label="Mobile" value={data.ownerPhone} mono />
                <div className="sm:col-span-2">
                  <Field label="Email" value={data.ownerEmail} />
                </div>
                {data.salesManager && <Field label="Sales manager" value={data.salesManager} />}
              </Section>

              <Section icon={<Landmark className="h-5 w-5" />} title="Bank account">
                <Field label="Bank" value={data.bankName} />
                <Field label="Account number" value={data.accountNumberMasked} mono />
                <Field label="Beneficiary" value={data.beneficiaryName} />
                <Field label="IFSC" value={data.ifscCode} mono />
              </Section>
            </div>

            <aside className="space-y-6">
              <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_8px_24px_-12px_rgba(23,63,99,0.18)]">
                <h2 className="text-lg font-semibold text-[#173F63]">Application</h2>
                <dl className="mt-4 space-y-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Status</dt>
                    <dd className="text-right font-medium text-slate-900">{status.label}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Finance</dt>
                    <dd className="font-medium text-slate-900">{data.financeEnabled ? "Enabled" : "Not enabled"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Last updated</dt>
                    <dd className="text-right font-medium text-slate-900">{fmtDate(data.updatedAt)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Documents</dt>
                    <dd className="font-medium text-slate-900">{data.documents.length}</dd>
                  </div>
                </dl>
                <div
                  className={`mt-5 rounded-xl p-4 text-sm ${
                    canContinue ? "bg-sky-50 text-sky-900" : "bg-amber-50 text-amber-900"
                  }`}
                >
                  {canContinue
                    ? "To continue this application, go back to the onboarding form and enter the code sent to the registered mobile or email."
                    : "This application is already with iTarang for review, so it can't be changed from the form. If something needs fixing, iTarang will send you a correction request."}
                </div>
              </div>
            </aside>

            <section className="lg:col-span-3">
              <div className="mb-4 flex items-end justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-[#173F63]">Documents on file</h2>
                  <p className="text-sm text-slate-500">Tap a document to view it. Viewing only — files can&apos;t be downloaded.</p>
                </div>
              </div>
              {data.documents.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center text-slate-500">
                  No documents are on file for this application yet.
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {data.documents.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      disabled={doc.kind === "other"}
                      onClick={() => setViewing(doc)}
                      className="group flex items-start gap-4 rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-[#1F5C8F]/40 hover:shadow-lg hover:shadow-[#1F5C8F]/10 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
                    >
                      <span
                        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${
                          doc.kind === "pdf" ? "bg-rose-50 text-rose-600" : "bg-sky-50 text-sky-600"
                        }`}
                      >
                        {doc.kind === "image" ? <FileImage className="h-6 w-6" /> : <FileText className="h-6 w-6" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-slate-900">{doc.label}</span>
                        <span className="mt-0.5 block truncate text-xs text-slate-500">{doc.fileName}</span>
                        <span className="mt-2 flex items-center gap-2">
                          {doc.status && (
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${
                                DOC_STATUS[doc.status] ?? "bg-slate-100 text-slate-600"
                              }`}
                            >
                              {doc.status.replace(/_/g, " ")}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#1F5C8F] opacity-0 transition group-hover:opacity-100">
                            <Eye className="h-3.5 w-3.5" /> View
                          </span>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        <p className="mt-10 text-center text-xs text-slate-400">
          iTarang · This page is private to you. Do not share this link — it will not open anywhere else.
        </p>
      </main>

      {viewing && !expired && (
        <DocumentViewer
          token={token}
          doc={viewing}
          watermark={`VIEW ONLY · iTarang · ${data.companyName ?? ""}`}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

function DocumentViewer({
  token,
  doc,
  watermark,
  onClose,
}: {
  token: string;
  doc: ExistingDocument;
  watermark: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  // Keyed by page, so a page change shows the spinner without resetting state in the effect.
  const [shown, setShown] = useState<{ key: string; src: string; w: number; h: number } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [zoom, setZoom] = useState(1);
  const pageKey = `${doc.id}:${page}`;
  const error = failed?.key === pageKey ? failed.message : null;
  const src = shown?.key === pageKey ? shown.src : null;
  const size = shown?.key === pageKey ? { w: shown.w, h: shown.h } : null;

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    const key = `${doc.id}:${page}`;
    const setError = (message: string) => setFailed({ key, message });
    (async () => {
      try {
        const res = await fetch(
          `/api/dealer/onboarding/existing/${encodeURIComponent(token)}/doc/${doc.id}?p=${page}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          if (!cancelled) setError(res.status === 403 ? "This link has expired." : "This document could not be opened.");
          return;
        }
        const n = Number(res.headers.get("X-Page-Count") || "1");
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          if (!cancelled && url) {
            setShown({ key, src: url, w: img.naturalWidth, h: img.naturalHeight });
            setPageCount(Number.isFinite(n) && n > 0 ? n : 1);
          }
        };
        img.onerror = () => !cancelled && setError("This document could not be shown.");
        img.src = url;
      } catch {
        if (!cancelled) setError("This document could not be opened.");
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [token, doc.id, page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setPage((p) => Math.min(p + 1, pageCount - 1));
      if (e.key === "ArrowLeft") setPage((p) => Math.max(p - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pageCount]);

  const marks = useMemo(() => Array.from({ length: 24 }), []);
  const width = size ? Math.min(size.w, 900) * zoom : 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/90 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-white">
        <div className="min-w-0">
          <p className="truncate font-semibold">{doc.label}</p>
          <p className="flex items-center gap-1.5 text-xs text-white/60">
            <Lock className="h-3 w-3" /> View only — download is turned off
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} className="rounded-lg p-2 hover:bg-white/10" aria-label="Zoom out">
            <ZoomOut className="h-5 w-5" />
          </button>
          <span className="w-12 text-center text-sm tabular-nums text-white/80">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} className="rounded-lg p-2 hover:bg-white/10" aria-label="Zoom in">
            <ZoomIn className="h-5 w-5" />
          </button>
          <button type="button" onClick={onClose} className="ml-2 rounded-lg p-2 hover:bg-white/10" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 sm:p-8">
        {error ? (
          <div className="mx-auto mt-20 max-w-sm rounded-2xl bg-white/5 p-6 text-center text-white/80 ring-1 ring-white/10">{error}</div>
        ) : !src || !size ? (
          <div className="mt-24 flex justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-white/70" />
          </div>
        ) : (
          <div
            className="relative mx-auto overflow-hidden rounded-lg bg-white shadow-2xl"
            style={{ width, aspectRatio: `${size.w} / ${size.h}`, maxWidth: zoom <= 1 ? "100%" : undefined }}
          >
            {/* Painted as a background, not an <img>: no "Save image as". */}
            <div className="absolute inset-0 bg-contain bg-center bg-no-repeat" style={{ backgroundImage: `url(${src})` }} />
            <div className="pointer-events-none absolute inset-0 grid grid-cols-3 content-around gap-y-16 overflow-hidden opacity-[0.13]">
              {marks.map((_, i) => (
                <span key={i} className="-rotate-[28deg] whitespace-nowrap text-center text-sm font-bold uppercase tracking-widest text-slate-900">
                  {watermark}
                </span>
              ))}
            </div>
            {/* Shield over the page: right-click / long-press hit this, not the picture. */}
            <div className="absolute inset-0" onContextMenu={(e) => e.preventDefault()} />
          </div>
        )}
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-4 border-t border-white/10 py-3 text-white">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-lg p-2 hover:bg-white/10 disabled:opacity-30"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="text-sm tabular-nums">
            Page {page + 1} of {pageCount}
          </span>
          <button
            type="button"
            disabled={page >= pageCount - 1}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg p-2 hover:bg-white/10 disabled:opacity-30"
            aria-label="Next page"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
}
