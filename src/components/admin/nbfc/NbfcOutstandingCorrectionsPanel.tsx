"use client";

/**
 * E-111 — admin-facing panel listing the items the CEO flagged for correction.
 *
 * Rendered on /admin/nbfc/{id}/approval whenever the latest correction round
 * is `open`. Groups items by section (Master / Documents / Agreement), shows
 * the CEO's per-item remark + previous value snapshot, and exposes a "Fix"
 * deep-link into the relevant edit page with `?focus=<targetKey>` so the
 * destination control can auto-scroll + highlight.
 *
 * A single "Submit corrections for CEO review" button transitions the NBFC
 * back to `pending_admin_review`. The server then auto-resolves every
 * pending item with a snapshot of the live value/file URL.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  MinusCircle,
  Send,
} from "lucide-react";
import {
  type CorrectionKind,
  type CorrectionSection,
  SECTION_LABELS,
} from "@/lib/nbfc/admin/correction-catalog";

export interface OutstandingItem {
  id: number;
  kind: CorrectionKind;
  targetKey: string;
  targetRefId: number | null;
  label: string;
  section: CorrectionSection;
  remark: string | null;
  previousValue: string | null;
  previousFileUrl: string | null;
  resolutionStatus: "pending" | "resolved" | "dismissed";
  newValue?: string | null;
  newFileUrl?: string | null;
}

export interface OutstandingRound {
  id: number;
  roundNumber: number;
  status: "open" | "resolved" | "superseded";
  summaryRemarks: string | null;
  items: OutstandingItem[];
  pendingCount: number;
  totalCount: number;
}

interface Props {
  nbfcId: number;
  round: OutstandingRound;
}

function deepLinkFor(
  nbfcId: number,
  section: CorrectionSection,
  targetKey: string,
): string {
  const focus = encodeURIComponent(targetKey);
  switch (section) {
    case "master_details":
      return `/admin/nbfc/${nbfcId}/edit?focus=${focus}`;
    case "compliance_documents":
      return `/admin/nbfc/${nbfcId}/documents?focus=${focus}`;
    case "agreement":
      return `/admin/nbfc/${nbfcId}/lsp-agreement?focus=${focus}`;
  }
}

export default function NbfcOutstandingCorrectionsPanel({
  nbfcId,
  round,
}: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<CorrectionSection, OutstandingItem[]>();
    for (const item of round.items) {
      const arr = map.get(item.section) ?? [];
      arr.push(item);
      map.set(item.section, arr);
    }
    return map;
  }, [round.items]);

  const pendingCount = round.items.filter(
    (i) => i.resolutionStatus === "pending",
  ).length;

  async function dismissItem(itemId: number) {
    const reason = window.prompt(
      "Dismiss this flagged item without changing it — provide a reason for the CEO:",
    );
    if (!reason || !reason.trim()) return;
    setError(null);
    const res = await fetch(
      `/api/admin/nbfc/${nbfcId}/corrections/items/${itemId}/dismiss`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(
        (body as { message?: string; error?: string }).message ??
          (body as { error?: string }).error ??
          `Dismiss failed (${res.status})`,
      );
      return;
    }
    router.refresh();
  }

  async function submitForReview() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/nbfc/${nbfcId}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: "pending_admin_review",
          reason: `Corrections submitted for round #${round.roundNumber}`,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          (body as { message?: string; error?: string }).message ??
            (body as { error?: string }).error ??
            `Submit failed (${res.status})`,
        );
        return;
      }
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (round.status !== "open") {
    return null;
  }

  return (
    <section
      id="outstanding-corrections"
      data-testid="outstanding-corrections-panel"
      className="card-iTarang p-6 md:p-7 space-y-5"
      style={{
        borderLeft: "4px solid var(--color-warning)",
      }}
    >
      <header className="space-y-1">
        <p className="section-label">
          CEO requested corrections · Round #{round.roundNumber}
        </p>
        <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)]">
          {pendingCount} item{pendingCount === 1 ? "" : "s"} pending
        </h2>
        {round.summaryRemarks && (
          <p className="text-sm text-[color:var(--color-ink)] mt-1">
            <span className="font-semibold">CEO note:</span> {round.summaryRemarks}
          </p>
        )}
      </header>

      <div className="space-y-4">
        {Array.from(grouped.entries()).map(([section, items]) => (
          <div
            key={section}
            className="rounded-xl border border-[color:var(--color-border)] p-4 space-y-3"
          >
            <p className="section-label-muted">{SECTION_LABELS[section]}</p>
            {items.map((it) => (
              <ItemRow
                key={it.id}
                nbfcId={nbfcId}
                item={it}
                onDismiss={() => dismissItem(it.id)}
              />
            ))}
          </div>
        ))}
      </div>

      {error && (
        <p
          data-testid="outstanding-corrections-error"
          className="text-sm rounded-lg px-3 py-2"
          style={{
            background: "var(--color-danger-bg)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-3 pt-2 border-t border-[color:var(--color-border)]">
        <button
          type="button"
          data-testid="submit-corrections-for-review"
          disabled={submitting}
          onClick={submitForReview}
          className={
            submitting
              ? "btn-primary opacity-50 cursor-not-allowed inline-flex items-center gap-2"
              : "btn-primary inline-flex items-center gap-2"
          }
        >
          {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
          <Send className="w-4 h-4" />
          Submit corrections for CEO review
        </button>
      </div>
    </section>
  );
}

function ItemRow({
  nbfcId,
  item,
  onDismiss,
}: {
  nbfcId: number;
  item: OutstandingItem;
  onDismiss: () => void;
}) {
  const link = deepLinkFor(nbfcId, item.section, item.targetKey);
  const isPending = item.resolutionStatus === "pending";
  const isResolved = item.resolutionStatus === "resolved";
  const isDismissed = item.resolutionStatus === "dismissed";
  const valueLabel = isResolved ? "Was" : "Current value";
  const fileLabel = isResolved ? "Was" : "Current file";
  return (
    <div className="flex items-start gap-3 rounded-lg p-3 border border-[color:var(--color-border)] bg-[color:var(--color-bg)]">
      <div className="shrink-0 mt-0.5">
        {isPending ? (
          <AlertCircle
            className="w-5 h-5"
            style={{ color: "var(--color-warning)" }}
          />
        ) : isDismissed ? (
          <MinusCircle
            className="w-5 h-5"
            style={{ color: "var(--color-ink-muted)" }}
          />
        ) : (
          <CheckCircle2
            className="w-5 h-5"
            style={{ color: "var(--color-success)" }}
          />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
          {item.label}
        </p>
        {item.remark && (
          <p className="text-xs text-[color:var(--color-ink)]">
            <span className="font-semibold">CEO:</span> {item.remark}
          </p>
        )}
        {item.previousValue && !item.previousFileUrl && (
          <p className="text-xs text-[color:var(--color-ink-muted)]">
            {valueLabel}:{" "}
            <span className="font-mono">{item.previousValue}</span>
          </p>
        )}
        {item.previousFileUrl && (
          <p className="text-xs text-[color:var(--color-ink-muted)]">
            {fileLabel}:{" "}
            <a
              href={item.previousFileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[color:var(--color-brand-sky)] underline"
            >
              View
            </a>
          </p>
        )}
        {isResolved && item.newValue && !item.newFileUrl && (
          <p
            className="text-xs"
            style={{ color: "var(--color-success)" }}
          >
            Updated to:{" "}
            <span className="font-mono">{item.newValue}</span>
          </p>
        )}
        {isResolved && item.newFileUrl && (
          <p
            className="text-xs"
            style={{ color: "var(--color-success)" }}
          >
            Updated to:{" "}
            <a
              href={item.newFileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
              style={{ color: "var(--color-success)" }}
            >
              View
            </a>
          </p>
        )}
      </div>
      {isPending && (
        <div className="flex flex-col gap-1 shrink-0">
          <Link
            href={link}
            className="btn-primary inline-flex items-center gap-1 text-xs"
          >
            Fix
            <ArrowRight className="w-3 h-3" />
          </Link>
          <button
            type="button"
            onClick={onDismiss}
            className="text-[10px] text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-danger)]"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
