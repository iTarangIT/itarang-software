"use client";

/**
 * E-280 — sales invoices the Drive scan could not fully handle.
 *
 * Two different problems, deliberately shown apart, because conflating them
 * told an admin the wrong thing on the expense side and would here too:
 *
 *   FILES that never became an invoice — unreadable, unsupported, or the scan
 *   failed on them. Their value is MISSING from revenue, and somebody has to
 *   act or the CEO's number is quietly short. Short list, urgent, always on top.
 *
 *   INVOICES that imported but look wrong — a date that disagrees with the
 *   folder it was filed in, arithmetic that does not add up, an entity the
 *   signals disagreed on, or a possible duplicate. These ARE counted in
 *   revenue; they want a human's eye, not a rescue.
 *
 * The second list used to print each row's flags as one amber paragraph, which
 * ran three unrelated problems together and made 18 rows unreadable. Each flag
 * is now its own chip, coloured by whether it can affect the MONEY on the row
 * or only its filing, and the figures the paragraph described in words are
 * shown as figures when a row is opened. See src/lib/sales/attentionReasons.ts.
 *
 * Renders nothing when both lists are empty, so a healthy setup costs no screen.
 */

import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ExternalLink,
  FileWarning,
  Loader2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { readJsonBody, readJsonData } from "@/lib/drive/scanClient";
import {
  ATTENTION_META,
  parseAttentionReasons,
  type AttentionCode,
  type AttentionReason,
} from "@/lib/sales/attentionReasons";

interface AttentionFile {
  id: string;
  drive_file_id: string;
  drive_file_name: string | null;
  folder_path: string | null;
  status: string;
  reason: string | null;
  created_at: string;
}

/**
 * Narrower than the payload by choice — the route sends every column of the
 * row, so the figures below cost no extra request.
 */
interface FlaggedInvoice {
  id: string;
  invoice_number: string | null;
  customer_name: string | null;
  invoice_date: string | null;
  sub_total: string | null;
  tax_total: string | null;
  total: string | null;
  folder_path: string | null;
  document_url: string | null;
  attention_reason: string | null;
}

const INR = (v: string | null) =>
  v == null ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** "2 Jul 2026" — the ISO string is for machines. */
function fmtDate(iso: string | null): string {
  if (!iso) return "No date";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** Drive has no stored link, but a file id is enough to build one. */
function driveLink(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

/** What went wrong with a file, in words rather than a column value. */
const FILE_STATUS_LABEL: Record<string, string> = {
  failed: "Could not read",
  needs_attention: "Needs a look",
  unsupported: "Unsupported file",
};

export function SalesScanAttentionPanel() {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<AttentionCode | "all">("all");

  const files = useQuery({
    queryKey: ["sales-runs", "attention"],
    queryFn: async () => {
      const r = await fetch("/api/admin/sales-invoices/drive/runs?view=attention", {
        cache: "no-store",
      });
      const d = await readJsonData<{ files: AttentionFile[] }>(r, "Could not load scan results");
      return d.files ?? [];
    },
  });

  const invoices = useQuery({
    queryKey: ["sales-runs", "flagged-invoices"],
    queryFn: async () => {
      const r = await fetch("/api/admin/sales-invoices/drive/runs?view=invoices", {
        cache: "no-store",
      });
      const d = await readJsonData<{ invoices: FlaggedInvoice[] }>(
        r,
        "Could not load flagged invoices",
      );
      return d.invoices ?? [];
    },
  });

  const clearFlag = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/sales-invoices/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ needs_attention: false }),
      });
      await readJsonBody(r, "Could not clear the flag");
    },
    onSuccess: () => {
      // Everything that counts or lists these rows.
      for (const key of [
        ["sales-runs", "flagged-invoices"],
        ["ceo-invoices"],
        ["dashboard-metrics", "ceo"],
      ]) {
        qc.invalidateQueries({ queryKey: key });
      }
    },
  });

  const unreadable = files.data ?? [];

  /**
   * Parse once per render, not once per row per render, and sort the money
   * problems to the top — the ordering IS the triage.
   */
  const flagged = useMemo(() => {
    const rows = (invoices.data ?? []).map((inv) => ({
      inv,
      reasons: parseAttentionReasons(inv.attention_reason),
    }));
    const weight = (r: AttentionReason[]) => (r.some((x) => x.severity === "amount") ? 0 : 1);
    return rows.sort((a, b) => weight(a.reasons) - weight(b.reasons));
  }, [invoices.data]);

  /** One chip per problem actually present, most common first. */
  const chips = useMemo(() => {
    const counts = new Map<AttentionCode, number>();
    for (const row of flagged) {
      for (const code of new Set(row.reasons.map((r) => r.code))) {
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([code, count]) => ({ code, count, ...ATTENTION_META[code] }))
      .sort(
        (a, b) =>
          (a.severity === "amount" ? 0 : 1) - (b.severity === "amount" ? 0 : 1) ||
          b.count - a.count,
      );
  }, [flagged]);

  const visible =
    filter === "all" ? flagged : flagged.filter((r) => r.reasons.some((x) => x.code === filter));

  if (files.isLoading || invoices.isLoading) {
    return (
      <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
        <p className="text-xs text-gray-500 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking sales imports…
        </p>
      </div>
    );
  }

  const loadError = files.error ?? invoices.error;
  if (!loadError && unreadable.length + flagged.length === 0) return null;

  return (
    <div
      className="p-6 rounded-2xl bg-white border border-amber-200 shadow-sm space-y-5"
      data-testid="sales-attention-panel"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
        <h2 className="text-sm font-semibold text-gray-900">Sales invoices to check</h2>
        <div className="flex items-center gap-2 ml-auto">
          {unreadable.length > 0 && (
            <Badge variant="danger">{unreadable.length} not imported</Badge>
          )}
          {flagged.length > 0 && <Badge variant="warning">{flagged.length} to check</Badge>}
        </div>
      </div>

      {loadError && (
        <p className="text-xs text-red-800" data-testid="sales-attention-error">
          {(loadError as Error).message}
        </p>
      )}

      {unreadable.length > 0 && (
        <section className="space-y-2">
          <p className="text-xs text-gray-600">
            Not imported — the value on these files is missing from revenue.
          </p>
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100">
            {unreadable.map((f) => (
              <li key={f.id} className="px-4 py-3" data-testid="sales-attention-file">
                <div className="flex flex-wrap items-center gap-2">
                  <FileWarning className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                  <a
                    href={driveLink(f.drive_file_id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-brand-700 hover:underline inline-flex items-center gap-1"
                  >
                    {f.drive_file_name || f.drive_file_id}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                  <Badge variant="danger">{FILE_STATUS_LABEL[f.status] ?? f.status}</Badge>
                </div>
                <p className="text-xs text-gray-600 mt-1">{f.reason || "Unknown problem."}</p>
                {f.folder_path && (
                  <p className="text-[11px] text-gray-500 mt-0.5">{f.folder_path}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {flagged.length > 0 && (
        <section className="space-y-3">
          <p className="text-xs text-gray-600">
            Imported and counted. Open a row to see the figures, or clear it once you have
            looked.
          </p>

          {chips.length > 1 && (
            <div className="flex flex-wrap gap-2">
              <FilterChip
                active={filter === "all"}
                onClick={() => setFilter("all")}
                label="All"
                count={flagged.length}
              />
              {chips.map((c) => (
                <FilterChip
                  key={c.code}
                  active={filter === c.code}
                  onClick={() => setFilter(filter === c.code ? "all" : c.code)}
                  label={c.label}
                  count={c.count}
                />
              ))}
            </div>
          )}

          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100">
            {visible.map(({ inv, reasons }) => (
              <FlaggedRow
                key={inv.id}
                invoice={inv}
                reasons={reasons}
                open={openId === inv.id}
                onToggle={() => setOpenId(openId === inv.id ? null : inv.id)}
                onClear={() => clearFlag.mutate(inv.id)}
                clearing={clearFlag.isPending && clearFlag.variables === inv.id}
              />
            ))}
          </ul>

          {visible.length === 0 && (
            <p className="text-xs text-gray-500">No invoice has that problem.</p>
          )}
          {clearFlag.isError && (
            <p className="text-xs text-red-800">{(clearFlag.error as Error).message}</p>
          )}
        </section>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "px-3 py-1 rounded-full border text-xs font-medium transition-colors",
        active
          ? "bg-brand-600 text-white border-brand-600"
          : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50",
      )}
    >
      {label} <span className={cn("tabular-nums", active ? "text-white/80" : "text-gray-400")}>{count}</span>
    </button>
  );
}

function FlaggedRow({
  invoice: inv,
  reasons,
  open,
  onToggle,
  onClear,
  clearing,
}: {
  invoice: FlaggedInvoice;
  reasons: AttentionReason[];
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
  clearing: boolean;
}) {
  const sub = inv.sub_total == null ? null : Number(inv.sub_total);
  const tax = inv.tax_total == null ? null : Number(inv.tax_total);
  const total = inv.total == null ? null : Number(inv.total);
  const expected = sub != null && tax != null ? sub + tax : null;
  const drift = expected != null && total != null ? expected - total : null;

  return (
    <li className="px-4 py-3" data-testid="sales-attention-invoice">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? "Hide details" : "Show details"}
          className="mt-0.5 shrink-0 text-gray-400 hover:text-gray-700 rounded focus:outline-none focus:ring-2 focus:ring-brand-sky/40"
        >
          <ChevronRight className={cn("w-4 h-4 transition-transform", open && "rotate-90")} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {inv.document_url ? (
              <a
                href={inv.document_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-brand-700 hover:underline"
              >
                {inv.invoice_number || "(no number)"}
              </a>
            ) : (
              <span className="text-sm font-medium text-gray-900">
                {inv.invoice_number || "(no number)"}
              </span>
            )}
            <span className="text-xs text-gray-600 truncate max-w-[22rem]">
              {inv.customer_name || "No customer"}
            </span>
            <span className="text-xs text-gray-500">{fmtDate(inv.invoice_date)}</span>
            <span className="text-sm font-semibold text-gray-900 ml-auto tabular-nums">
              {INR(inv.total)}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {reasons.map((r, i) => (
              <Badge key={`${r.code}-${i}`} variant={r.severity === "amount" ? "warning" : "muted"}>
                {r.label}
              </Badge>
            ))}
            <button
              type="button"
              onClick={onClear}
              disabled={clearing}
              title="The invoice is fine — take it off this list"
              className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-brand-700 disabled:opacity-50"
            >
              {clearing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              Looks right
            </button>
          </div>

          {open && (
            <div className="mt-3 rounded-xl border border-brand-100 bg-brand-50/40 p-3 space-y-3">
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
                {sub != null && (
                  <Figure label="Sub-total" value={INR(inv.sub_total)} />
                )}
                {tax != null && <Figure label="Tax" value={INR(inv.tax_total)} />}
                {expected != null && (
                  <Figure label="Expected" value={`₹${expected.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`} />
                )}
                <Figure
                  label="On invoice"
                  value={INR(inv.total)}
                  note={
                    drift != null && Math.abs(drift) > 0.01
                      ? `${drift > 0 ? "short by" : "over by"} ₹${Math.abs(drift).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
                      : undefined
                  }
                />
                {inv.folder_path && <Figure label="Filed in" value={inv.folder_path} />}
              </dl>

              <ul className="space-y-1">
                {reasons.map((r, i) => (
                  <li key={`${r.code}-detail-${i}`} className="text-xs text-gray-700">
                    {r.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <>
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-900 tabular-nums">
        {value}
        {note && <span className="ml-2 text-amber-700 font-medium">{note}</span>}
      </dd>
    </>
  );
}
