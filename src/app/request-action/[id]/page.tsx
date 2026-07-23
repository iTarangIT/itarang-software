"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

// Change 5 — the "act from email" confirm page. The admin notification email
// links here with a single-use token. The page validates the token, shows the
// NBFC request, and lets the admin Forward / Push / Decline without hunting for
// the lead. An admin session is still required (for attribution); if absent the
// API returns 401 and we prompt to sign in.

interface ReqItem {
  id: string;
  doc_label: string;
  upload_status: string | null;
}
interface Wrapper {
  id: string;
  request_type: string;
  status: string;
  nbfc_comments: string | null;
  target_doc_key: string | null;
  lead_id: string;
}

export default function NbfcRequestActionPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const id = params?.id as string;
  const token = search.get("token") ?? "";

  const [request, setRequest] = useState<Wrapper | null>(null);
  const [items, setItems] = useState<ReqItem[]>([]);
  const [statusLabel, setStatusLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [labels, setLabels] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/admin/nbfc-requests/${id}/act?token=${encodeURIComponent(token)}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (json.ok) {
        setRequest(json.request);
        setItems(json.items ?? []);
        setStatusLabel(json.status_label ?? json.request?.status ?? "");
      } else {
        setError(
          json.error === "INVALID_TOKEN"
            ? "This link has expired or has already been used."
            : "Request not found.",
        );
      }
    } catch {
      setError("Could not load the request.");
    } finally {
      setLoading(false);
    }
  }, [id, token]);

  useEffect(() => {
    if (id && token) load();
    else {
      setError("Missing token.");
      setLoading(false);
    }
  }, [id, token, load]);

  const act = async (action: "forward" | "push" | "decline") => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { token, action };
      if (action === "forward") {
        const parsed = labels
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((doc_label) => ({ doc_label }));
        if (parsed.length === 0) {
          setError("Enter at least one document label.");
          setBusy(false);
          return;
        }
        body.items = parsed;
      }
      const res = await fetch(`/api/admin/nbfc-requests/${id}/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.ok) {
        setDone(
          action === "forward"
            ? "Forwarded to the dealer."
            : action === "push"
              ? "Pushed to the NBFC."
              : "Request declined.",
        );
      } else if (res.status === 401) {
        setError(
          "Please sign in as an admin (in this browser) and reopen this link to action it.",
        );
      } else {
        setError(json.error ?? "Action failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-start justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm mt-10">
        <h1 className="text-lg font-bold text-slate-800 mb-1">
          NBFC document request
        </h1>
        <p className="text-xs text-slate-400 mb-4">Review &amp; action</p>

        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : error && !request ? (
          <p className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        ) : done ? (
          <p className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-3 text-sm text-emerald-700">
            {done}
          </p>
        ) : request ? (
          <>
            <dl className="text-sm space-y-1.5 mb-4">
              <div className="flex justify-between">
                <dt className="text-slate-500">Lead</dt>
                <dd className="font-medium text-slate-800">{request.lead_id}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Type</dt>
                <dd className="font-medium text-slate-800 capitalize">
                  {request.request_type.replace(/_/g, " ")}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Status</dt>
                <dd className="font-medium text-slate-800">{statusLabel}</dd>
              </div>
            </dl>

            {request.nbfc_comments ? (
              <p className="mb-4 rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-sm text-slate-600">
                “{request.nbfc_comments}”
              </p>
            ) : null}

            {items.length > 0 ? (
              <ul className="mb-4 space-y-1 text-xs">
                {items.map((it) => (
                  <li key={it.id} className="flex justify-between">
                    <span className="text-slate-600">{it.doc_label}</span>
                    <span className="text-slate-400">
                      {it.upload_status ?? "not_uploaded"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {error ? (
              <p className="mb-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
                {error}
              </p>
            ) : null}

            {request.status === "admin_review_upload" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => act("push")}
                className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? "Working…" : "Push finished documents to NBFC"}
              </button>
            ) : (
              <>
                <label className="block text-xs font-semibold text-slate-600 mb-1">
                  Documents to request from the dealer (one per line)
                </label>
                <textarea
                  value={labels}
                  onChange={(e) => setLabels(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm mb-2"
                  placeholder="e.g. Updated bank statement"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act("forward")}
                    className="flex-1 rounded-md bg-slate-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    {busy ? "Working…" : "Forward to dealer"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act("decline")}
                    className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700 disabled:opacity-50"
                  >
                    Decline
                  </button>
                </div>
              </>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
