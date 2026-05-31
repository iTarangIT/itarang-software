"use client";

/**
 * Loan-agreement track panel — BRD Addendum V0.2 §11. Winner-only, Stage 2,
 * shown beside E-NACH. Initiate signing by the configured method (Digio e-sign
 * / upload / autofetch), then the Digio loan-agreement webhook flips it to
 * signed; "Record signed/failed" is the manual fallback (also the upload path).
 *
 * §11.5 — the signed agreement is NOT the disbursal gate; the Step-5 OTP is.
 * This panel surfaces status only and never blocks sanction.
 */
import { useCallback, useEffect, useState } from "react";

type Attempt = {
  id: string;
  method: string | null;
  status: string;
  digio_document_id: string | null;
  signed_document_url: string | null;
  failure_reason: string | null;
  created_at: string;
};

type Gate = {
  applicable: boolean;
  satisfied: boolean;
  status: string | null;
  method: string | null;
  reason: string;
};

type Resp = {
  ok: boolean;
  gate?: Gate;
  method?: string | null;
  attempt_count?: number;
  attempts?: Attempt[];
  can_act?: boolean;
  error?: string;
};

const BADGE: Record<string, string> = {
  signed: "bg-emerald-100 text-emerald-700",
  in_progress: "bg-amber-100 text-amber-700",
  pending: "bg-amber-100 text-amber-700",
  failed: "bg-red-100 text-red-700",
  skipped: "bg-slate-200 text-slate-600",
};

const METHOD_LABEL: Record<string, string> = {
  upload: "Upload signed copy",
  digio: "iTarang Digio e-sign",
  api_autofetch: "API autofetch",
};

export default function AgreementTrackPanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedUrl, setSignedUrl] = useState("");
  const [showUpload, setShowUpload] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/nbfc/agreement/${leadId}`);
      setData((await res.json()) as Resp);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/agreement/${leadId}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : "{}",
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setShowUpload(false);
      setSignedUrl("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const gate = data?.gate;
  const method = data?.method ?? gate?.method ?? null;
  const attempts = data?.attempts ?? [];
  const latest = attempts[0];
  const status = latest?.status ?? "pending";
  const canAct = data?.can_act ?? false;
  const terminalGood = status === "signed" || status === "skipped";

  if (data && gate && !gate.applicable) {
    return (
      <div className="rounded-lg border border-slate-200 p-3">
        <p className="text-sm font-semibold text-slate-700">Loan Agreement</p>
        <p className="text-[11px] text-slate-500 mt-1">{gate.reason}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-800">Loan Agreement</span>
        {latest ? (
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${BADGE[status] ?? "bg-slate-100 text-slate-500"}`}>
            {status.replace(/_/g, " ")}
          </span>
        ) : null}
      </div>

      <p className="text-[11px] text-slate-500">
        {method ? METHOD_LABEL[method] ?? method : "No method configured"}
        {latest?.digio_document_id ? ` · Digio ${latest.digio_document_id}` : ""}
        {latest?.failure_reason ? ` · ${latest.failure_reason}` : ""}
      </p>

      {latest?.signed_document_url ? (
        <a
          href={latest.signed_document_url}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-[color:var(--color-brand-sky)] underline"
        >
          View signed document
        </a>
      ) : null}

      {error && <p className="text-[11px] text-red-600">{error}</p>}

      {canAct && !terminalGood && (
        <div className="flex flex-wrap gap-2">
          {/* Initiate by the configured method. */}
          {(!latest || status === "failed") && (
            <button
              onClick={() => post("/initiate")}
              disabled={busy}
              className="px-3 py-1.5 rounded-md bg-[color:var(--color-brand-navy)] text-white text-xs font-semibold disabled:opacity-50"
            >
              {method === "digio"
                ? latest
                  ? "Re-send e-sign"
                  : "Initiate e-sign"
                : latest
                  ? "Restart"
                  : "Start agreement"}
            </button>
          )}
          {/* Upload / record-signed fallback (and the upload-method happy path). */}
          <button
            onClick={() => setShowUpload((s) => !s)}
            disabled={busy}
            className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-xs font-semibold disabled:opacity-50"
          >
            {method === "upload" ? "Upload signed copy" : "Record signed"}
          </button>
          <button
            onClick={() => post("/record-manual", { status: "failed", failure_reason: "Marked failed by operations" })}
            disabled={busy}
            className="px-3 py-1.5 rounded-md border border-red-300 text-red-700 text-xs font-semibold disabled:opacity-50"
          >
            Record failed
          </button>
        </div>
      )}

      {showUpload && (
        <div className="space-y-2">
          <input
            value={signedUrl}
            onChange={(e) => setSignedUrl(e.target.value)}
            placeholder="Signed document URL (optional — only stored if you opted in)"
            className="w-full text-xs border border-slate-200 rounded-md px-2 py-1.5"
          />
          <button
            onClick={() => post("/record-manual", { status: "signed", signed_document_url: signedUrl.trim() || null })}
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50"
          >
            Mark signed
          </button>
        </div>
      )}

      <p className="text-[10px] leading-relaxed text-slate-400 border-t border-slate-100 pt-2">
        §11.5 — the signed agreement is not the disbursal gate; the Step-5 OTP
        (dealer side) is. Document storage is optional (§11.4).
      </p>
    </div>
  );
}
