"use client";

/**
 * E-387 — CIBIL review on an Acquire lead (parent / child approval hierarchy).
 *
 * Child   : upload the CIBIL PDF + note (+ optional score) → "Send to <parent>".
 * Parent  : open the report, Approve, or Reject with a mandatory reason
 *           (a rejection closes the file for this NBFC).
 * Everyone: sees the status, who sent it, who decided and why.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type Review = {
  id: string;
  status: "pending" | "approved" | "rejected";
  note: string;
  cibil_score: number | null;
  report_file_name: string | null;
  decision_reason: string | null;
  created_at: string;
  decided_at: string | null;
  submitted_by: { id: string; name: string };
  approver: { id: string; name: string };
  decided_by: { id: string; name: string } | null;
};

type State = {
  review: Review | null;
  gate_applies: boolean;
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
  const fileRef = useRef<HTMLInputElement>(null);

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
      if (fileRef.current) fileRef.current.value = "";
      await load();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^(CONFLICT|BAD_REQUEST|FORBIDDEN): /, "") : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "approve" | "reject") {
    if (decision === "reject" && !reason.trim()) return setError("A reason is required to reject.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reason: decision === "reject" ? reason.trim() : null }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setRejecting(false);
      setReason("");
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

  const { review, me, gate_applies } = state;
  // Nothing to show for a tenant not using the hierarchy on this lead.
  if (!review && !me.is_child && !gate_applies) return null;

  const parent = me.parent_name ?? "your approver";

  return (
    <section className="border border-slate-200 rounded-xl bg-white p-5 space-y-3">
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
                ? "Approved"
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
        </div>
      ) : null}

      {/* Child / sender view */}
      {me.can_submit && !closed ? (
        <div className="rounded-lg border border-dashed border-slate-300 px-4 py-3 space-y-2.5">
          <p className="text-xs font-semibold text-slate-700">
            {me.is_child ? `Send the CIBIL report to ${parent}` : "Upload the CIBIL report (recorded as approved by you)"}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-slate-600">
              <span className="block mb-1 font-bold uppercase tracking-wider text-[10px] text-slate-500">CIBIL report (PDF)</span>
              <input ref={fileRef} type="file" accept="application/pdf,.pdf" disabled={busy} className="text-xs" />
            </label>
            <label className="text-xs text-slate-600">
              <span className="block mb-1 font-bold uppercase tracking-wider text-[10px] text-slate-500">Score (optional)</span>
              <input
                type="number"
                min={300}
                max={900}
                value={score}
                onChange={(e) => setScore(e.target.value)}
                disabled={busy}
                className="w-24 border border-slate-300 rounded px-2 py-1 text-sm"
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
          {!rejecting ? (
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
                  setRejecting(true);
                  setError(null);
                }}
                disabled={busy}
                className="px-4 py-1.5 text-sm font-bold rounded border border-red-300 text-red-700 bg-white disabled:opacity-50"
              >
                Reject
              </button>
            </>
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

      {me.is_child && review?.status === "pending" ? (
        <p className="text-xs text-amber-800">Your actions on this lead are locked until {parent} decides.</p>
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
