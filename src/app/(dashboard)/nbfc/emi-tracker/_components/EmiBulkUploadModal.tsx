"use client";

/**
 * EmiBulkUploadModal — premium bulk-upload wizard for the EMI Tracker.
 *
 * Three steps: (1) download template + drop the filled sheet, (2) a row-by-row /
 * cell-by-cell validation preview where the operator picks which rows to apply,
 * (3) a result summary. It parses the sheet client-side (positional, so the
 * duplicated "EMI Collect Date" headers are unambiguous), POSTs to the
 * validate/commit endpoint which re-validates authoritatively, and writes DISPLAY
 * overrides only. Matches the RecordPaymentModal visual language.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  CellIssue,
  ReportRow,
  UploadSummary,
} from "@/lib/nbfc/emi-tracker/bulkUpload";

const MAX_BYTES = 5 * 1024 * 1024;

const inr = (n: number | null) =>
  n == null ? "—" : `₹${Math.round(n).toLocaleString("en-IN")}`;
const fmtDate = (s: string | null) =>
  !s ? "—" : new Date(`${s}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const STATE_LABEL: Record<ReportRow["state"], string> = {
  ready: "Ready",
  duplicate: "Duplicate",
  error: "Error",
};
const STATE_PILL: Record<ReportRow["state"], string> = {
  ready: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  duplicate: "bg-amber-50 text-amber-700 ring-amber-200",
  error: "bg-red-50 text-red-700 ring-red-200",
};
const STATE_BORDER: Record<ReportRow["state"], string> = {
  ready: "border-l-emerald-400",
  duplicate: "border-l-amber-400",
  error: "border-l-red-400",
};
const STATUS_PILL: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700",
  overdue: "bg-red-50 text-red-700",
  closed: "bg-slate-100 text-slate-600",
};

type Step = "upload" | "preview" | "result";

export default function EmiBulkUploadModal({
  onClose,
  onApplied,
}: {
  onClose: () => void;
  onApplied: () => void;
}) {
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [report, setReport] = useState<ReportRow[]>([]);
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [parsed, setParsed] = useState<{ header: unknown[]; rows: unknown[][] } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Rows with no matching loan the operator chose to force-import as standalone,
  // display-only tracker entries (E-183).
  const [standaloneSel, setStandaloneSel] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<{
    scheduleUpdated: number;
    recompute: { dpd: boolean; cds: boolean; pci: boolean; error: string | null };
  } | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  const validate = useCallback(async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError("File is larger than 5 MB.");
      return;
    }
    setBusy(true);
    setFileName(file.name);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error("The spreadsheet has no sheets.");
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
        header: 1,
        raw: true,
        defval: null,
        blankrows: false,
      });
      if (matrix.length < 2) throw new Error("The sheet has a header but no data rows.");
      const header = matrix[0];
      const rows = matrix.slice(1);

      const res = await fetch("/api/nbfc/emi-tracker/bulk-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "validate", header, rows }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.error ?? "Validation failed");

      const rep = data.report as ReportRow[];
      setParsed({ header, rows });
      setReport(rep);
      setSummary(data.summary as UploadSummary);
      setSelected(new Set(rep.filter((r) => r.state === "ready").map((r) => r.rowNumber)));
      setStandaloneSel(new Set());
      setStep("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read this file.");
      setFileName(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const onPick = (f: File | null | undefined) => {
    if (f) validate(f);
  };

  const toggleRow = (r: ReportRow) => {
    if (r.state === "error") return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(r.rowNumber)) next.delete(r.rowNumber);
      else next.add(r.rowNumber);
      return next;
    });
  };

  const toggleStandalone = (r: ReportRow) => {
    if (!r.noLoanMatch) return;
    setStandaloneSel((prev) => {
      const next = new Set(prev);
      if (next.has(r.rowNumber)) next.delete(r.rowNumber);
      else next.add(r.rowNumber);
      return next;
    });
  };

  const selectableCounts = useMemo(() => {
    const dup = report.filter((r) => r.state === "duplicate");
    const dupSelected = dup.filter((r) => selected.has(r.rowNumber)).length;
    const unmatched = report.filter((r) => r.noLoanMatch);
    const unmatchedSelected = unmatched.filter((r) => standaloneSel.has(r.rowNumber)).length;
    return {
      dupTotal: dup.length,
      dupSelected,
      unmatchedTotal: unmatched.length,
      unmatchedSelected,
    };
  }, [report, selected, standaloneSel]);

  const includeAllDuplicates = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      report.filter((r) => r.state === "duplicate").forEach((r) => next.add(r.rowNumber));
      return next;
    });
  };

  const includeAllStandalone = () => {
    setStandaloneSel((prev) => {
      const next = new Set(prev);
      report.filter((r) => r.noLoanMatch).forEach((r) => next.add(r.rowNumber));
      return next;
    });
  };

  const commit = async () => {
    if (!parsed || selected.size + standaloneSel.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/nbfc/emi-tracker/bulk-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "commit",
          header: parsed.header,
          rows: parsed.rows,
          includeRowNumbers: [...selected],
          standaloneRowNumbers: [...standaloneSel],
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.error ?? "Upload failed");
      setReport(data.report as ReportRow[]);
      setSummary(data.summary as UploadSummary);
      setResult({
        scheduleUpdated: (data.scheduleUpdated as number) ?? 0,
        recompute: data.recompute ?? { dpd: false, cds: false, pci: false, error: null },
      });
      setStep("result");
      const applied = data.applied as number;
      const standalone = (data.standaloneApplied as number) ?? 0;
      const emis = (data.scheduleUpdated as number) ?? 0;
      if (applied > 0 || standalone > 0)
        toast.success(
          [
            applied > 0 && `Updated ${applied} loan${applied === 1 ? "" : "s"}`,
            standalone > 0 && `imported ${standalone} standalone row${standalone === 1 ? "" : "s"}`,
            emis > 0 && `${emis} EMI${emis === 1 ? "" : "s"} marked paid`,
          ]
            .filter(Boolean)
            .join(" · ") + " on the EMI Tracker.",
        );
      else toast.warning("No rows were applied.");
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-6xl rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-3 border-b border-[color:var(--color-border)] p-5">
          <div className="min-w-0">
            <p className="section-label-muted">Bulk upload</p>
            <h2 className="mt-0.5 text-lg font-semibold text-[color:var(--color-brand-navy)]">
              Import EMI collection data
            </h2>
            <p className="mt-0.5 text-xs text-[color:var(--color-ink-muted)]">
              Match rows to loans by battery serial and update their tracker view. Canonical
              records are never changed.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-2xl leading-none text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </header>

        {/* ── Step: upload ─────────────────────────────────────────────────── */}
        {step === "upload" && (
          <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[color:var(--color-bg)] px-4 py-3">
              <div>
                <p className="text-sm font-medium text-[color:var(--color-ink)]">
                  New to this? Start with the template.
                </p>
                <p className="text-xs text-[color:var(--color-ink-muted)]">
                  Same columns as your sheet, with date cells pre-locked so nothing gets mangled.
                </p>
              </div>
              <a
                href="/api/nbfc/emi-tracker/template"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--color-border)] bg-white px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-bg)]"
              >
                <DownloadIcon /> Download template
              </a>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => onPick(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                onPick(e.dataTransfer.files?.[0]);
              }}
              className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition ${
                dragOver
                  ? "border-[color:var(--color-brand-sky)] bg-[color:var(--color-brand-sky)]/5"
                  : "border-slate-300 hover:border-[color:var(--color-brand-sky)]"
              }`}
            >
              <SpreadsheetIcon />
              <span className="text-sm font-medium text-[color:var(--color-ink)]">
                {busy ? "Reading…" : "Drop your Excel here, or click to browse"}
              </span>
              <span className="text-xs text-[color:var(--color-ink-muted)]">
                .xlsx, .xls or .csv · up to 5 MB
              </span>
            </button>

            {error && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
            )}
          </div>
        )}

        {/* ── Step: preview ────────────────────────────────────────────────── */}
        {step === "preview" && summary && (
          <>
            <div className="space-y-4 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <SummaryChip label="Total rows" value={summary.total} />
                <SummaryChip label="Ready" value={summary.ready} tone="ready" />
                <SummaryChip label="Duplicates" value={summary.duplicate} tone="duplicate" />
                <SummaryChip label="Errors" value={summary.error} tone="error" />
                {fileName && (
                  <span className="ml-auto truncate text-xs text-[color:var(--color-ink-muted)]">
                    {fileName}
                  </span>
                )}
              </div>

              {selectableCounts.dupTotal > 0 && selectableCounts.dupSelected < selectableCounts.dupTotal && (
                <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-800">
                  <span>
                    {selectableCounts.dupTotal} row(s) are already on the tracker and will be skipped.
                  </span>
                  <button
                    type="button"
                    onClick={includeAllDuplicates}
                    className="rounded-md border border-amber-300 bg-white px-2 py-1 font-semibold text-amber-800 hover:bg-amber-100"
                  >
                    Overwrite all duplicates
                  </button>
                </div>
              )}

              {selectableCounts.unmatchedTotal > 0 && (
                <div className="flex items-center justify-between rounded-lg border border-sky-200 bg-sky-50/70 px-3 py-2 text-xs text-sky-800">
                  <span>
                    {selectableCounts.unmatchedTotal} row(s) have no matching loan on the tracker.
                    Import them as standalone, display-only entries — no loan is created.
                  </span>
                  <button
                    type="button"
                    onClick={includeAllStandalone}
                    disabled={selectableCounts.unmatchedSelected === selectableCounts.unmatchedTotal}
                    className="rounded-md border border-sky-300 bg-white px-2 py-1 font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-50"
                  >
                    Import all unmatched
                  </button>
                </div>
              )}

              <div className="max-h-[52vh] overflow-auto rounded-xl border border-[color:var(--color-border)]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-[color:var(--color-bg)]">
                    <tr className="text-left text-xs uppercase text-[color:var(--color-ink-muted)]">
                      <th className="px-3 py-2 w-10"></th>
                      <th className="px-3 py-2">Row</th>
                      <th className="px-3 py-2">Driver</th>
                      <th className="px-3 py-2">Battery serial</th>
                      <th className="px-3 py-2">Financier</th>
                      <th className="px-3 py-2 text-right">EMI</th>
                      <th className="px-3 py-2">Progress</th>
                      <th className="px-3 py-2">Next due</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.map((r) => (
                      <PreviewRow
                        key={r.rowNumber}
                        r={r}
                        checked={selected.has(r.rowNumber)}
                        onToggle={() => toggleRow(r)}
                        standaloneChecked={standaloneSel.has(r.rowNumber)}
                        onToggleStandalone={() => toggleStandalone(r)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              {error && (
                <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
              )}
            </div>

            <footer className="flex items-center justify-between gap-2 border-t border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-4">
              <button
                type="button"
                onClick={() => {
                  setStep("upload");
                  setError(null);
                }}
                disabled={busy}
                className="rounded-lg px-4 py-2 text-sm font-medium text-[color:var(--color-ink-muted)] hover:bg-slate-100 disabled:opacity-50"
              >
                ← Choose another file
              </button>
              <button
                type="button"
                onClick={commit}
                disabled={busy || selected.size + standaloneSel.size === 0}
                className="rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? "Applying…" : `Apply ${selected.size + standaloneSel.size} selected`}
              </button>
            </footer>
          </>
        )}

        {/* ── Step: result ─────────────────────────────────────────────────── */}
        {step === "result" && summary && (
          <>
            <div className="space-y-4 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <SummaryChip
                  label="Loans updated"
                  value={report.filter((r) => r.applied && r.loanId != null).length}
                  tone="ready"
                />
                {report.some((r) => r.applied && r.loanId == null) && (
                  <SummaryChip
                    label="Imported standalone"
                    value={report.filter((r) => r.applied && r.loanId == null).length}
                    tone="ready"
                  />
                )}
                <SummaryChip
                  label="EMIs marked paid"
                  value={result?.scheduleUpdated ?? 0}
                  tone="ready"
                />
                <SummaryChip
                  label="Skipped"
                  value={report.filter((r) => !r.applied).length}
                  tone="duplicate"
                />
              </div>

              {result && (result.scheduleUpdated > 0 || result.recompute.cds || result.recompute.pci) && (
                <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-xs text-[color:var(--color-ink)]">
                  <span className="font-semibold">Dependent calculations refreshed:</span>{" "}
                  {[
                    result.recompute.dpd && "DPD aging",
                    result.recompute.cds && "CDS (Credit Default Score)",
                    result.recompute.pci && "PCI (Payment Consistency)",
                  ]
                    .filter(Boolean)
                    .join(" · ") || "none"}
                  {result.recompute.error && (
                    <span className="ml-1 text-amber-700">
                      — some scores may refresh on the nightly run.
                    </span>
                  )}
                  <span className="ml-1 text-[color:var(--color-ink-muted)]">
                    Battery Monitoring &amp; Lead Intelligence now reflect the new schedule.
                  </span>
                </div>
              )}
              <div className="max-h-[52vh] overflow-auto rounded-xl border border-[color:var(--color-border)]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-[color:var(--color-bg)]">
                    <tr className="text-left text-xs uppercase text-[color:var(--color-ink-muted)]">
                      <th className="px-3 py-2">Row</th>
                      <th className="px-3 py-2">Driver</th>
                      <th className="px-3 py-2">Battery serial</th>
                      <th className="px-3 py-2">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.map((r) => (
                      <tr key={r.rowNumber} className="border-t border-[color:var(--color-border)]">
                        <td className="px-3 py-2 tabular-nums text-[color:var(--color-ink-muted)]">{r.rowNumber}</td>
                        <td className="px-3 py-2">{r.borrower ?? "—"}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.batteryNo ?? "—"}</td>
                        <td className="px-3 py-2">
                          {r.applied ? (
                            <span className="text-emerald-700">
                              {r.loanId == null ? "✓ Imported (standalone)" : "✓ Updated"}
                            </span>
                          ) : (
                            <span className="text-[color:var(--color-ink-muted)]">
                              Skipped
                              {r.issues[0] ? ` — ${r.issues[0].message}` : r.state === "duplicate" ? " — already on tracker" : ""}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-4">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white"
              >
                Done
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function PreviewRow({
  r,
  checked,
  onToggle,
  standaloneChecked,
  onToggleStandalone,
}: {
  r: ReportRow;
  checked: boolean;
  onToggle: () => void;
  standaloneChecked: boolean;
  onToggleStandalone: () => void;
}) {
  const d = r.derived;
  // A no-loan-match row can't use the normal checkbox (it's an error), but it
  // CAN be force-imported as a standalone entry — reflect that in the checkbox.
  const rowChecked = r.noLoanMatch ? standaloneChecked : checked;
  const borderTone = r.noLoanMatch && standaloneChecked ? "border-l-sky-400" : STATE_BORDER[r.state];
  return (
    <tr className={`border-t border-l-4 border-[color:var(--color-border)] align-top ${borderTone}`}>
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={rowChecked}
          disabled={r.state === "error" && !r.noLoanMatch}
          onChange={r.noLoanMatch ? onToggleStandalone : onToggle}
          className="h-4 w-4 accent-[color:var(--color-brand-navy)] disabled:opacity-40"
        />
      </td>
      <td className="px-3 py-2 tabular-nums text-[color:var(--color-ink-muted)]">{r.rowNumber}</td>
      <td className="px-3 py-2">
        <div className="font-medium text-[color:var(--color-brand-navy)]">{r.borrower ?? "—"}</div>
      </td>
      <td className="px-3 py-2 font-mono text-xs">{r.batteryNo ?? "—"}</td>
      <td className="px-3 py-2">{d.financier ?? "—"}</td>
      <td className="px-3 py-2 text-right tabular-nums">{inr(d.emi)}</td>
      <td className="px-3 py-2 tabular-nums">
        <div>
          {d.progress_total != null ? `${d.progress_paid ?? 0}/${d.progress_total}` : (d.progress_paid ?? 0)}
        </div>
        {r.scheduleUpdateCount > 0 && r.state !== "error" && (
          <div className="mt-0.5 text-[11px] font-medium text-emerald-700">
            → {r.scheduleUpdateCount} EMI{r.scheduleUpdateCount === 1 ? "" : "s"} paid
          </div>
        )}
        {r.scheduleNote && (
          <div className="mt-0.5 text-[11px] text-amber-700">{r.scheduleNote}</div>
        )}
      </td>
      <td className="px-3 py-2">{fmtDate(d.next_due)}</td>
      <td className="px-3 py-2">
        {d.status ? (
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_PILL[d.status] ?? "bg-slate-100 text-slate-600"}`}>
            {d.status}
            {d.status === "overdue" && d.dpd ? ` · ${d.dpd}d` : ""}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2">
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${STATE_PILL[r.state]}`}>
          {STATE_LABEL[r.state]}
        </span>
        {r.note && r.state === "duplicate" && (
          <p className="mt-1 text-[11px] text-amber-700">{r.note}</p>
        )}
        {r.issues.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {r.issues.map((iss: CellIssue, i) => (
              <li key={i} className="text-[11px] text-red-600">
                <span className="font-medium">{iss.column}:</span> {iss.message}
              </li>
            ))}
          </ul>
        )}
        {r.noLoanMatch && (
          <button
            type="button"
            onClick={onToggleStandalone}
            className={`mt-1.5 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold ${
              standaloneChecked
                ? "border-sky-300 bg-sky-100 text-sky-800"
                : "border-sky-300 bg-white text-sky-700 hover:bg-sky-50"
            }`}
          >
            {standaloneChecked ? "✓ Will import as standalone" : "Import anyway (no loan)"}
          </button>
        )}
      </td>
    </tr>
  );
}

function SummaryChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ready" | "duplicate" | "error";
}) {
  const toneCls =
    tone === "ready"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : tone === "duplicate"
        ? "bg-amber-50 text-amber-700 ring-amber-200"
        : tone === "error"
          ? "bg-red-50 text-red-700 ring-red-200"
          : "bg-white text-[color:var(--color-ink)] ring-[color:var(--color-border)]";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold ring-1 ${toneCls}`}>
      {value}
      <span className="text-xs font-normal opacity-80">{label}</span>
    </span>
  );
}

function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function SpreadsheetIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[color:var(--color-brand-sky)]" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  );
}
