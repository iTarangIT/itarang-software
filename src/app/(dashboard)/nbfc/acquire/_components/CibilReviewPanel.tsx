"use client";

/**
 * E-387 — CIBIL review on an Acquire lead (parent / child approval hierarchy).
 *
 * Child   : upload the CIBIL PDF + note (+ optional score) → "Send to <parent>".
 * Parent  : open the report, then Approve, Approve with conditions (E-389),
 *           Request documents (E-389 — goes to the iTarang admin, the review
 *           stays pending), or Reject with a mandatory reason (a rejection
 *           closes the file for this NBFC).
 * Everyone: sees the status, who sent it, who decided and why.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import RequestMoreDocsModal, { type DocItem } from "@/components/kyc/step3/RequestMoreDocsModal";
import { CONDITION_DOCS, conditionDocLabel } from "@/lib/nbfc/condition-docs";

type Review = {
  id: string;
  status: "pending" | "approved" | "rejected";
  note: string;
  cibil_score: number | null;
  report_file_name: string | null;
  decision_reason: string | null;
  /** E-389 — set when approved with conditions. */
  conditions: string | null;
  /** E-393 — documents picked in the conditions multi-select. */
  condition_docs?: string[];
  /** E-389 — document requests the approver raised from this review. */
  doc_requests: Array<{
    id: string;
    status: string;
    status_label: string;
    items: string[];
    comments: string | null;
    created_at: string;
  }>;
  created_at: string;
  decided_at: string | null;
  submitted_by: { id: string; name: string };
  approver: { id: string; name: string };
  decided_by: { id: string; name: string } | null;
};

type State = {
  review: Review | null;
  gate_applies: boolean;
  /** Approver view: the credit verifier(s) who should upload the report on this file. */
  awaiting: {
    verifiers: Array<{ id: string; name: string }>;
    assigned_at: string | null;
    last_reminder_at: string | null;
    can_remind: boolean;
  } | null;
  me: {
    user_id: string;
    is_child: boolean;
    parent_name: string | null;
    delegated_steps: string[];
    can_submit: boolean;
    can_decide: boolean;
  };
};

function fmt(ts: string | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STATUS_STYLE: Record<Review["status"], string> = {
  pending: "bg-amber-50 text-amber-800 border-amber-200",
  approved: "bg-emerald-50 text-emerald-800 border-emerald-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
};

export default function CibilReviewPanel({ leadId, closed }: { leadId: string; closed: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [score, setScore] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [withConditions, setWithConditions] = useState(false);
  const [conditions, setConditions] = useState("");
  const [conditionDocs, setConditionDocs] = useState<string[]>([]);
  const [docMenuOpen, setDocMenuOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [docsSent, setDocsSent] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [reminding, setReminding] = useState(false);
  const [reminder, setReminder] = useState("");
  const [reminderSent, setReminderSent] = useState<string | null>(null);

  const base = `/api/nbfc/acquire/${encodeURIComponent(leadId)}/cibil-review`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(base, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setState(j as State);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    const file = fileRef.current?.files?.[0];
    if (!file) return setError("Attach the CIBIL report (PDF).");
    if (!note.trim()) return setError("Write a note for the approver.");
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("note", note.trim());
      if (score.trim()) fd.append("score", score.trim());
      const res = await fetch(base, { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setNote("");
      setScore("");
      setFileName(null);
      if (fileRef.current) fileRef.current.value = "";
      await load();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^(CONFLICT|BAD_REQUEST|FORBIDDEN): /, "") : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remind() {
    setBusy(true);
    setError(null);
    setReminderSent(null);
    try {
      const res = await fetch(`${base}/remind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: reminder.trim() || null }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setReminding(false);
      setReminder("");
      setReminderSent(`Reminder sent to ${(j.sent_to as string[] | undefined)?.join(", ") ?? "the credit verifier"}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^(CONFLICT|BAD_REQUEST|FORBIDDEN): /, "") : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function requestDocs({
    items,
    doc_for,
  }: {
    items: DocItem[];
    doc_for: "primary" | "co_borrower";
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetch(`${base}/request-docs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          doc_for,
          items: items.map((it) => ({ doc_label: it.doc_label, reason: it.reason, is_required: it.is_required })),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          success: false,
          error: String(j.error ?? `HTTP ${res.status}`).replace(/^(CONFLICT|BAD_REQUEST|FORBIDDEN): /, ""),
        };
      }
      setDocsSent("Request sent to the iTarang admin. You will be notified when the documents are back.");
      await load();
      router.refresh();
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function decide(decision: "approve" | "approve_with_conditions" | "reject") {
    if (decision === "reject" && !reason.trim()) return setError("A reason is required to reject.");
    if (decision === "approve_with_conditions" && !conditions.trim() && conditionDocs.length === 0) {
      return setError("Pick the documents (or write the conditions) for this approval.");
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision,
          reason: decision === "reject" ? reason.trim() : null,
          conditions: decision === "approve_with_conditions" ? conditions.trim() || null : null,
          condition_docs: decision === "approve_with_conditions" ? conditionDocs : [],
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setRejecting(false);
      setReason("");
      setWithConditions(false);
      setConditions("");
      setConditionDocs([]);
      setDocMenuOpen(false);
      await load();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^(CONFLICT|BAD_REQUEST|FORBIDDEN): /, "") : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <section className="border border-slate-200 rounded-xl bg-white p-4 text-xs text-red-700">
        CIBIL review: {loadError}
      </section>
    );
  }
  if (!state) return null;

  const { review, me, gate_applies, awaiting } = state;
  const waitingOnVerifier = !review && !me.is_child && !!awaiting && awaiting.verifiers.length > 0;
  // Nothing to show for a tenant not using the hierarchy on this lead.
  if (!review && !me.is_child && !gate_applies && !waitingOnVerifier) return null;
  const verifierNames = awaiting?.verifiers.map((v) => v.name).join(", ") ?? "";

  const parent = me.parent_name ?? "your approver";

  return (
    <section id="cibil-review" className="scroll-mt-24 border border-slate-200 rounded-xl bg-white p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">CIBIL review</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {me.is_child
              ? `You upload the CIBIL report and a note; ${parent} approves or rejects it.`
              : "CIBIL approval comes before any other step on this file."}
          </p>
        </div>
        {review ? (
          <span className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${STATUS_STYLE[review.status]}`}>
            {review.status === "pending"
              ? `Waiting for ${review.approver.name}`
              : review.status === "approved"
                ? review.conditions
                  ? "Approved with conditions"
                  : "Approved"
                : "Rejected"}
          </span>
        ) : null}
      </div>

      {review ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm space-y-1.5">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600">
            <span>
              Sent by <b className="text-slate-800">{review.submitted_by.name}</b> · {fmt(review.created_at)}
            </span>
            {review.cibil_score != null ? (
              <span>
                CIBIL score <b className="text-slate-800 tabular-nums">{review.cibil_score}</b>
              </span>
            ) : null}
            <a
              href={`${base}/file`}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-[color:var(--color-brand-sky)] hover:underline"
            >
              Open CIBIL report{review.report_file_name ? ` (${review.report_file_name})` : ""}
            </a>
          </div>
          <p className="text-slate-700 whitespace-pre-wrap">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400 mr-1.5">Note</span>
            {review.note}
          </p>
          {review.status !== "pending" ? (
            <p className="text-xs text-slate-600">
              {review.status === "approved" ? "Approved" : "Rejected"} by{" "}
              <b className="text-slate-800">{review.decided_by?.name ?? "—"}</b> · {fmt(review.decided_at)}
              {review.decision_reason ? (
                <>
                  {" "}
                  — <span className={review.status === "rejected" ? "text-red-700" : ""}>{review.decision_reason}</span>
                </>
              ) : null}
            </p>
          ) : null}
          {review.conditions ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              <span className="block text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                Approved with conditions
              </span>
              <span className="whitespace-pre-wrap">{review.conditions}</span>
            </div>
          ) : null}
          {review.doc_requests.length ? (
            <div className="pt-1 space-y-1.5">
              <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Documents requested before deciding
              </span>
              {review.doc_requests.map((d) => (
                <div
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs"
                >
                  <span className="text-slate-700">
                    {d.items.length ? d.items.join(", ") : d.comments ?? "Documents"}
                    <span className="text-slate-400"> · {fmt(d.created_at)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span
                      className={`rounded-full border px-2 py-0.5 font-semibold ${
                        d.status === "pushed_to_nbfc" || d.status === "closed"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                          : d.status === "rejected"
                            ? "border-red-200 bg-red-50 text-red-700"
                            : "border-amber-200 bg-amber-50 text-amber-800"
                      }`}
                    >
                      {d.status_label}
                    </span>
                    <a href="#nbfc-requests" className="font-semibold text-[color:var(--color-brand-sky)] hover:underline">
                      View
                    </a>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Approver view — the credit verifier has not sent the report yet */}
      {waitingOnVerifier && !closed ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="text-sm text-amber-900">
              <p className="font-semibold">
                CIBIL report not uploaded yet by {verifierNames}
                {awaiting!.verifiers.length > 1 ? " (credit verifiers)" : " (credit verifier)"}.
              </p>
              <p className="text-xs text-amber-800 mt-0.5">
                File assigned {fmt(awaiting!.assigned_at)}
                {awaiting!.last_reminder_at ? ` · last reminder sent ${fmt(awaiting!.last_reminder_at)}` : ""}
              </p>
            </div>
            {awaiting!.can_remind && !reminding ? (
              <button
                onClick={() => {
                  setReminding(true);
                  setReminderSent(null);
                  setError(null);
                }}
                disabled={busy}
                className="px-3 py-1.5 text-sm font-bold rounded border border-amber-400 bg-white text-amber-900 hover:bg-amber-100 disabled:opacity-50"
              >
                Send reminder
              </button>
            ) : null}
          </div>
          {reminding ? (
            <div className="space-y-2">
              <textarea
                value={reminder}
                onChange={(e) => setReminder(e.target.value)}
                disabled={busy}
                rows={2}
                maxLength={500}
                className="w-full border border-amber-300 rounded px-2 py-1.5 text-sm bg-white"
                placeholder={`Message for ${verifierNames} (optional) — e.g. "CIBIL report for this file is not delivered yet, please upload today."`}
              />
              <div className="flex gap-2">
                <button
                  onClick={remind}
                  disabled={busy}
                  className="px-4 py-1.5 text-sm font-bold rounded bg-[color:var(--color-brand-navy)] text-white disabled:opacity-50"
                >
                  {busy ? "Sending…" : "Send"}
                </button>
                <button onClick={() => setReminding(false)} disabled={busy} className="text-xs text-slate-500 hover:underline">
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {reminderSent ? <p className="text-xs text-emerald-700">{reminderSent}</p> : null}
        </div>
      ) : null}

      {/* Child / sender view */}
      {me.can_submit && !closed ? (
        <div className="rounded-lg border border-dashed border-slate-300 px-4 py-3 space-y-2.5">
          <p className="text-xs font-semibold text-slate-700">
            {me.is_child ? `Send the CIBIL report to ${parent}` : "Upload the CIBIL report (recorded as approved by you)"}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="text-xs text-slate-600">
              <span className="block mb-1 font-bold uppercase tracking-wider text-[10px] text-slate-500">CIBIL report (PDF)</span>
              <input
                ref={fileRef}
                id={`cibil-file-${leadId}`}
                type="file"
                accept="application/pdf,.pdf"
                disabled={busy}
                className="sr-only"
                onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
              />
              <div className="flex items-center gap-2">
                <label
                  htmlFor={`cibil-file-${leadId}`}
                  className={`inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-brand-sky)] bg-sky-50 px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-navy)] hover:bg-sky-100 ${
                    busy ? "pointer-events-none opacity-50" : "cursor-pointer"
                  }`}
                >
                  <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                  </svg>
                  {fileName ? "Change PDF" : "Choose PDF"}
                </label>
                <span
                  className={`max-w-[16rem] truncate text-xs ${fileName ? "font-medium text-slate-800" : "text-slate-400"}`}
                  title={fileName ?? undefined}
                >
                  {fileName ?? "No file chosen"}
                </span>
                {fileName ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (fileRef.current) fileRef.current.value = "";
                      setFileName(null);
                    }}
                    disabled={busy}
                    className="text-xs text-slate-400 hover:text-red-600"
                    aria-label="Remove file"
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            </div>
            <label className="text-xs text-slate-600">
              <span className="block mb-1 font-bold uppercase tracking-wider text-[10px] text-slate-500">Score (optional)</span>
              <input
                type="number"
                min={300}
                max={900}
                value={score}
                onChange={(e) => setScore(e.target.value)}
                disabled={busy}
                className="w-24 border border-slate-300 rounded-md px-2 py-1.5 text-sm"
                placeholder="e.g. 742"
              />
            </label>
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={3}
            maxLength={2000}
            className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm"
            placeholder={me.is_child ? `Note for ${parent} — what you saw in the report, any concern…` : "Note — what you saw in the report"}
          />
          <button
            onClick={submit}
            disabled={busy}
            className="px-4 py-1.5 text-sm font-bold rounded bg-[color:var(--color-brand-navy)] text-white disabled:opacity-50"
          >
            {busy ? "Sending…" : me.is_child ? `Send to ${parent} for approval` : "Save CIBIL report"}
          </button>
        </div>
      ) : null}

      {/* Parent / approver view */}
      {me.can_decide && review?.status === "pending" && !closed ? (
        <div className="flex flex-wrap items-start gap-2">
          {!rejecting && !withConditions ? (
            <>
              <button
                onClick={() => decide("approve")}
                disabled={busy}
                className="px-4 py-1.5 text-sm font-bold rounded bg-emerald-600 text-white disabled:opacity-50"
              >
                {busy ? "Saving…" : "Approve"}
              </button>
              <button
                onClick={() => {
                  setWithConditions(true);
                  setError(null);
                }}
                disabled={busy}
                className="px-4 py-1.5 text-sm font-bold rounded border border-emerald-400 text-emerald-800 bg-white disabled:opacity-50"
              >
                Approve with conditions
              </button>
              <button
                onClick={() => {
                  setDocsOpen(true);
                  setDocsSent(null);
                  setError(null);
                }}
                disabled={busy}
                className="px-4 py-1.5 text-sm font-bold rounded border border-amber-400 text-amber-900 bg-white disabled:opacity-50"
              >
                Request documents
              </button>
              <button
                onClick={() => {
                  setRejecting(true);
                  setError(null);
                }}
                disabled={busy}
                className="px-4 py-1.5 text-sm font-bold rounded border border-red-300 text-red-700 bg-white disabled:opacity-50"
              >
                Reject
              </button>
            </>
          ) : withConditions ? (
            <div className="w-full space-y-2">
              {/* E-393 — multi-select of the documents the approval depends on.
                  They go out as a document request to the dealer / salesperson. */}
              <div className="relative">
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Documents required (pick one or more)</label>
                <button
                  type="button"
                  onClick={() => setDocMenuOpen((v) => !v)}
                  disabled={busy}
                  className="w-full flex items-center justify-between border border-emerald-300 rounded px-2 py-1.5 text-sm bg-white text-left"
                  aria-expanded={docMenuOpen}
                >
                  <span className={conditionDocs.length ? "text-slate-800" : "text-slate-400"}>
                    {conditionDocs.length
                      ? conditionDocs.map(conditionDocLabel).join(", ")
                      : "Select documents — e.g. RC Copy, co-borrower documents"}
                  </span>
                  <span className="text-slate-400 text-xs ml-2">{docMenuOpen ? "▲" : "▼"}</span>
                </button>
                {docMenuOpen ? (
                  <div className="absolute z-20 mt-1 w-full max-h-64 overflow-auto rounded border border-slate-200 bg-white shadow-lg p-1">
                    {(["primary", "co_borrower"] as const).map((party) => (
                      <div key={party} className="py-1">
                        <p className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          {party === "primary" ? "Customer" : "Co-borrower / guarantor"}
                        </p>
                        {CONDITION_DOCS.filter((d) => d.docFor === party).map((d) => {
                          const on = conditionDocs.includes(d.key);
                          return (
                            <label key={d.key} className="flex items-center gap-2 px-2 py-1 text-sm rounded hover:bg-slate-50 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() =>
                                  setConditionDocs((prev) => (on ? prev.filter((k) => k !== d.key) : [...prev, d.key]))
                                }
                                className="accent-emerald-600"
                              />
                              {d.label}
                            </label>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <textarea
                value={conditions}
                onChange={(e) => setConditions(e.target.value)}
                disabled={busy}
                rows={2}
                maxLength={2000}
                className="w-full border border-emerald-300 rounded px-2 py-1.5 text-sm"
                placeholder="Other conditions (optional) — e.g. max tenure 12 months…"
              />
              {conditionDocs.length ? (
                <p className="text-[11px] text-slate-500">
                  The picked documents are sent to the iTarang admin as a document request; the dealer / salesperson can upload them in one go or in parts.
                </p>
              ) : null}
              <div className="flex gap-2">
                <button
                  onClick={() => decide("approve_with_conditions")}
                  disabled={busy}
                  className="px-4 py-1.5 text-sm font-bold rounded bg-emerald-600 text-white disabled:opacity-50"
                >
                  {busy ? "Saving…" : "Approve with these conditions"}
                </button>
                <button onClick={() => setWithConditions(false)} disabled={busy} className="text-xs text-slate-500 hover:underline">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="w-full space-y-2">
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={busy}
                rows={2}
                maxLength={2000}
                className="w-full border border-red-300 rounded px-2 py-1.5 text-sm"
                placeholder="Reason for rejecting (required) — the file will be closed for this NBFC"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => decide("reject")}
                  disabled={busy}
                  className="px-4 py-1.5 text-sm font-bold rounded bg-red-600 text-white disabled:opacity-50"
                >
                  {busy ? "Rejecting…" : "Reject and close file"}
                </button>
                <button onClick={() => setRejecting(false)} disabled={busy} className="text-xs text-slate-500 hover:underline">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
      {docsSent ? <p className="text-xs text-emerald-700">{docsSent}</p> : null}

      <RequestMoreDocsModal
        open={docsOpen}
        onClose={() => setDocsOpen(false)}
        leadId={leadId}
        defaultDocFor="primary"
        submitItems={requestDocs}
        title="Request documents before the CIBIL decision"
        noteText="This request goes to the iTarang admin, who forwards it to the dealer / salesperson / customer on WhatsApp. The CIBIL report stays waiting for your decision; you will be notified when the documents are back."
        submitLabel="Send to admin"
      />

      {me.is_child && review?.status === "pending" ? (
        <p className="text-xs text-amber-800">
          {review.doc_requests.some((d) => d.status !== "closed" && d.status !== "rejected")
            ? `${parent} asked for more documents before deciding — still waiting for approval. `
            : ""}
          Your actions on this lead are locked until {parent} decides.
        </p>
      ) : null}
      {me.is_child && review?.status === "approved" ? (
        <p className="text-xs text-slate-600">
          {parent} now owns this lead.{" "}
          {me.delegated_steps.length
            ? "You can also work on the steps your NBFC admin gave you; the rest are view-only."
            : "Your part is done — the lead is view-only for you."}
        </p>
      ) : null}

      {error ? <div className="px-3 py-2 bg-red-50 text-red-700 text-xs rounded">{error}</div> : null}
    </section>
  );
}
