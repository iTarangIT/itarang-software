"use client";

/**
 * Loan Agreement track panel — BRD Addendum V0.3.1 §17 ("iTarang eSign").
 *
 * Winner-only, Stage 2, beside E-NACH. Flow: the NBFC uploads the agreement
 * PDF → sends it for signature (customer signs; NBFC signatory co-signs
 * optionally) via iTarang eSign → on success the signed agreement + audit
 * trail can be downloaded.
 *
 * §5.4 vendor abstraction: this NBFC-facing UI says "iTarang eSign" and never
 * exposes the underlying provider or its document id.
 * §17.5: the signed agreement is NOT the disbursal gate (Step-5 OTP is).
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Attempt = {
  id: string;
  method: string | null;
  status: string;
  digio_document_id: string | null; // kept in type, NEVER rendered (§5.4)
  source_document_url: string | null;
  signed_document_url: string | null;
  audit_trail_url: string | null;
  failure_reason: string | null;
  initiated_at: string | null;
  signed_at: string | null;
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
  customer_email?: string | null;
  attempt_count?: number;
  attempts?: Attempt[];
  can_act?: boolean;
  error?: string;
};

const STATUS_META: Record<string, { label: string; text: string; bg: string; dot: string; accent: string }> = {
  signed: { label: "Signed", text: "text-emerald-700", bg: "bg-emerald-50 ring-emerald-200", dot: "bg-emerald-500", accent: "#059669" },
  in_progress: { label: "Awaiting signature", text: "text-amber-700", bg: "bg-amber-50 ring-amber-200", dot: "bg-amber-500", accent: "#d97706" },
  pending: { label: "Awaiting upload", text: "text-slate-500", bg: "bg-slate-100 ring-slate-200", dot: "bg-slate-400", accent: "#94a3b8" },
  ready: { label: "Ready to send", text: "text-sky-700", bg: "bg-sky-50 ring-sky-200", dot: "bg-sky-500", accent: "#0ea5e9" },
  failed: { label: "Failed", text: "text-rose-700", bg: "bg-rose-50 ring-rose-200", dot: "bg-rose-500", accent: "#e11d48" },
  skipped: { label: "Waived", text: "text-slate-500", bg: "bg-slate-100 ring-slate-200", dot: "bg-slate-400", accent: "#94a3b8" },
};
function statusMeta(s: string) {
  return STATUS_META[s] ?? STATUS_META.pending;
}

function fmtDate(s: string | null): string {
  if (!s) return "";
  try {
    return new Date(s).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return "";
  }
}

function AgreementGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M5 3h9l5 5v7" />
      <path d="M5 3v18h7" />
      <path d="M15.5 19.5 19 16l2 2-3.5 3.5L15 22z" />
    </svg>
  );
}

function StatusPill({ statusKey }: { statusKey: string }) {
  const m = statusMeta(statusKey);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ring-1 ${m.bg} ${m.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

function FileInput({ inputRef, onPick }: { inputRef: React.RefObject<HTMLInputElement | null>; onPick: (f: File) => void }) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept="application/pdf"
      className="hidden"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) onPick(f);
        e.currentTarget.value = "";
      }}
    />
  );
}

export default function AgreementTrackPanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const [signingUrl, setSigningUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [nbfcSigns, setNbfcSigns] = useState(false);
  const [nbfcSignerName, setNbfcSignerName] = useState("");
  const [nbfcSignerEmail, setNbfcSignerEmail] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

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

  async function post(path: string, body?: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/agreement/${leadId}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : "{}",
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & Record<string, unknown>;
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      setShowManual(false);
      setManualUrl("");
      await load();
      return j;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function uploadPdf(file: File) {
    if (file.type && file.type !== "application/pdf") {
      setError("Only PDF files are accepted.");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/nbfc/agreement/${leadId}/upload`, { method: "POST", body: fd });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  async function initiate() {
    if (nbfcSigns && !nbfcSignerEmail.trim()) {
      setError("Enter the NBFC signatory's email, or untick “NBFC signatory also signs” to send for the customer's signature only.");
      return;
    }
    const j = await post("/initiate", {
      nbfc_signs: nbfcSigns,
      nbfc_signer_name: nbfcSigns ? nbfcSignerName.trim() : "",
      nbfc_signer_email: nbfcSigns ? nbfcSignerEmail.trim() : "",
    });
    const url = (j?.customer_signing_url as string | undefined) ?? null;
    if (url) setSigningUrl(url);
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  const gate = data?.gate;
  const attempts = data?.attempts ?? [];
  const latest = attempts[0];
  const status = latest?.status ?? "pending";
  const canAct = data?.can_act ?? false;
  const hasSource = !!latest?.source_document_url;
  const effSigningUrl = signingUrl;
  const notApplicable = !!(data && gate && !gate.applicable);
  const customerEmail = data?.customer_email ?? null;

  // Pill: distinguish "ready to send" from "awaiting upload" within pending.
  const pillKey = status === "pending" && hasSource ? "ready" : status;
  const meta = statusMeta(pillKey);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(2,49,78,0.04),0_12px_28px_-16px_rgba(2,49,78,0.18)]">
      {/* Header */}
      <div className="relative flex items-start gap-3 bg-gradient-to-br from-white to-slate-50 px-4 pb-3.5 pt-4">
        <span className="absolute inset-y-0 left-0 w-1" style={{ background: meta.accent }} />
        <div
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white shadow-sm"
          style={{ backgroundImage: "linear-gradient(135deg, var(--color-brand-sky), var(--color-brand-royal))" }}
        >
          <AgreementGlyph className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-slate-900">Loan Agreement</h3>
            {latest && !notApplicable && <StatusPill statusKey={pillKey} />}
          </div>
          <p className="mt-0.5 text-[11px] text-slate-400">Sign &amp; file the loan agreement · iTarang eSign</p>
        </div>
      </div>

      {/* Body */}
      <div className="space-y-3 px-4 pb-4">
        {notApplicable ? (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-500 ring-1 ring-slate-100">{gate?.reason}</p>
        ) : (
          <>
            {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-700 ring-1 ring-rose-100">{error}</p>}

            {/* pending: upload, then send */}
            {(status === "pending" || !latest) && (
              <>
                {!canAct && <p className="text-[11px] text-slate-400">Awaiting operations to upload the agreement.</p>}
                {canAct && !hasSource && (
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver(false);
                      const f = e.dataTransfer.files?.[0];
                      if (f) void uploadPdf(f);
                    }}
                    onClick={() => fileRef.current?.click()}
                    className={`cursor-pointer rounded-xl border-2 border-dashed p-5 text-center transition ${
                      dragOver ? "border-[color:var(--color-brand-sky)] bg-[var(--brand-sky-soft)]" : "border-slate-200 bg-slate-50/60 hover:bg-slate-50"
                    } ${uploading ? "opacity-60" : ""}`}
                  >
                    <FileInput inputRef={fileRef} onPick={(f) => void uploadPdf(f)} />
                    <AgreementGlyph className="mx-auto h-6 w-6 text-slate-300" />
                    <p className="mt-2 text-xs font-semibold text-slate-700">{uploading ? "Uploading…" : "Upload the loan agreement (PDF)"}</p>
                    <p className="mt-0.5 text-[10px] text-slate-400">Drag &amp; drop or click to browse · PDF up to 15 MB</p>
                  </div>
                )}
                {canAct && hasSource && (
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-2 rounded-xl border border-slate-200/80 bg-white px-3 py-2">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--brand-sky-soft)] text-[color:var(--color-brand-sky)]">
                        <AgreementGlyph className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-slate-800">Agreement uploaded</p>
                        <p className="text-[10px] text-slate-400">Ready to send for signature</p>
                      </div>
                      <button onClick={() => fileRef.current?.click()} disabled={uploading} className="text-[11px] font-semibold text-slate-500 underline-offset-2 hover:underline disabled:opacity-40">
                        Replace
                      </button>
                      <FileInput inputRef={fileRef} onPick={(f) => void uploadPdf(f)} />
                    </div>
                    {/* Customer is signer #1 — the agreement is emailed to the
                        borrower for Aadhaar eSign. Email comes from the lead. */}
                    <div className="flex items-start gap-2 rounded-lg bg-slate-50 px-2.5 py-2 ring-1 ring-slate-100">
                      <span className="mt-px text-[11px]">✉️</span>
                      <p className="text-[11px] leading-relaxed text-slate-600">
                        {customerEmail ? (
                          <>Emailed to the customer for Aadhaar eSign: <span className="font-semibold text-slate-800">{customerEmail}</span></>
                        ) : (
                          <span className="font-medium text-rose-600">No customer email on file — add the customer&apos;s email before sending.</span>
                        )}
                      </p>
                    </div>

                    {/* NBFC signatory is optional (§17.3). When opted in, the
                        operator types whoever will co-sign — name + email. */}
                    <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-600">
                      <input type="checkbox" checked={nbfcSigns} onChange={(e) => setNbfcSigns(e.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300 accent-[color:var(--color-brand-sky)]" />
                      NBFC signatory also signs <span className="text-slate-400">(optional)</span>
                    </label>
                    {nbfcSigns && (
                      <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-2.5">
                        <input
                          value={nbfcSignerName}
                          onChange={(e) => setNbfcSignerName(e.target.value)}
                          placeholder="NBFC signatory name"
                          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[11px]"
                        />
                        <input
                          type="email"
                          value={nbfcSignerEmail}
                          onChange={(e) => setNbfcSignerEmail(e.target.value)}
                          placeholder="NBFC signatory email (for Aadhaar eSign)"
                          className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[11px]"
                        />
                        <p className="text-[10px] text-slate-400">The agreement is emailed to this signatory to e-sign after the customer.</p>
                      </div>
                    )}
                    <button
                      onClick={() => void initiate()}
                      disabled={busy || uploading || !customerEmail}
                      className="w-full rounded-lg px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40"
                      style={{ backgroundImage: "linear-gradient(135deg, var(--color-brand-sky), var(--color-brand-navy))" }}
                    >
                      {busy ? "Sending…" : "Send for signature via iTarang eSign"}
                    </button>
                  </div>
                )}
              </>
            )}

            {/* in_progress: awaiting customer signature */}
            {status === "in_progress" && (
              <div className="space-y-2.5">
                <div className="flex items-center gap-2 text-[11px] text-slate-500">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
                  </span>
                  Awaiting customer signature.
                </div>
                {effSigningUrl && (
                  <div className="flex items-center gap-2 rounded-lg bg-[var(--brand-sky-soft)] px-2.5 py-1.5">
                    <span className="truncate text-[11px] text-[color:var(--color-brand-sky)]">{effSigningUrl}</span>
                    <button onClick={() => copyLink(effSigningUrl)} className="ml-auto shrink-0 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50">
                      {copied ? "Copied" : "Copy link"}
                    </button>
                    <a href={effSigningUrl} target="_blank" rel="noreferrer" className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-[color:var(--color-brand-sky)] hover:bg-slate-50">
                      Open
                    </a>
                  </div>
                )}
                {canAct && (
                  <div className="flex flex-wrap items-center gap-3">
                    <button onClick={() => void initiate()} disabled={busy} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-brand-sky)] shadow-sm transition hover:bg-slate-50 disabled:opacity-40">
                      {busy ? "Resending…" : "Resend link"}
                    </button>
                    <button onClick={() => setShowManual((s) => !s)} className="text-[11px] font-medium text-slate-400 underline-offset-2 hover:underline">
                      {showManual ? "Hide manual fallback" : "Manual fallback"}
                    </button>
                  </div>
                )}
                {showManual && canAct && (
                  <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-2.5">
                    <input
                      value={manualUrl}
                      onChange={(e) => setManualUrl(e.target.value)}
                      placeholder="Signed document URL (optional — stored only if opted in)"
                      className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[11px]"
                    />
                    <div className="flex gap-2">
                      <button onClick={() => post("/record-manual", { status: "signed", signed_document_url: manualUrl.trim() || null })} disabled={busy} className="rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-40">
                        Record signed
                      </button>
                      <button onClick={() => post("/record-manual", { status: "failed", failure_reason: "Marked failed by operations" })} disabled={busy} className="rounded-md border border-rose-300 px-2.5 py-1 text-[11px] font-semibold text-rose-700 disabled:opacity-40">
                        Record failed
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* signed: success + downloads */}
            {status === "signed" && (
              <div className="space-y-2.5">
                <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 ring-1 ring-emerald-200">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-emerald-500 text-white">✓</span>
                  <div>
                    <p className="text-xs font-bold text-slate-800">Agreement signed</p>
                    {latest?.signed_at && <p className="text-[11px] text-slate-500">Signed on {fmtDate(latest.signed_at)}</p>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <a
                    href={`/api/nbfc/agreement/${leadId}/signed-pdf`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:brightness-110"
                    style={{ backgroundImage: "linear-gradient(135deg, var(--color-brand-sky), var(--color-brand-navy))" }}
                  >
                    Download agreement
                  </a>
                  <a
                    href={`/api/nbfc/agreement/${leadId}/audit-trail`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
                  >
                    Download audit trail
                  </a>
                </div>
              </div>
            )}

            {/* failed: reason + retry */}
            {status === "failed" && (
              <div className="space-y-2.5">
                <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-700 ring-1 ring-rose-100">
                  {latest?.failure_reason ?? "The agreement signing failed."}
                </p>
                {canAct && (
                  <div className="flex flex-wrap gap-2">
                    {hasSource && (
                      <button onClick={() => void initiate()} disabled={busy} className="rounded-lg px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-40" style={{ backgroundImage: "linear-gradient(135deg, var(--color-brand-sky), var(--color-brand-navy))" }}>
                        {busy ? "Retrying…" : "Retry"}
                      </button>
                    )}
                    <button onClick={() => fileRef.current?.click()} disabled={uploading} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">
                      {uploading ? "Uploading…" : "Re-upload PDF"}
                    </button>
                    <FileInput inputRef={fileRef} onPick={(f) => void uploadPdf(f)} />
                  </div>
                )}
              </div>
            )}

            {/* skipped */}
            {status === "skipped" && <p className="text-[11px] text-slate-500">Agreement marked not required.</p>}

            <p className="border-t border-slate-100 pt-2 text-[10px] leading-relaxed text-slate-400">
              §17.5 — the signed agreement is not the disbursal gate; the Step-5 OTP (dealer side) is. Document storage is optional (§17.4).
            </p>
          </>
        )}
      </div>
    </div>
  );
}
