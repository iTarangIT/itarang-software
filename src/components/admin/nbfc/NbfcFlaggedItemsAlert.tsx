"use client";

/**
 * E-111 — top-of-edit-page alert listing the CEO-flagged items relevant
 * to the current step (Step 1 master, Step 2 documents, or Step 3 LSP
 * agreement). Each row is a quick reminder; clicking it scrolls to the
 * target if the URL `?focus=<targetKey>` matches a `data-correction-target`
 * attribute somewhere in the page.
 */

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, ArrowDown } from "lucide-react";
import {
  type CorrectionKind,
  type CorrectionSection,
} from "@/lib/nbfc/admin/correction-catalog";

export interface FlaggedSummaryItem {
  kind: CorrectionKind;
  targetKey: string;
  label: string;
  remark: string | null;
  resolutionStatus: "pending" | "resolved" | "dismissed";
}

interface Props {
  section: CorrectionSection;
  items: FlaggedSummaryItem[];
  roundNumber: number;
}

export default function NbfcFlaggedItemsAlert({
  section,
  items,
  roundNumber,
}: Props) {
  const search = useSearchParams();
  const focus = search.get("focus");

  // When loaded with ?focus=, scroll to the matching element.
  useEffect(() => {
    if (!focus) return;
    const el = document.querySelector(
      `[data-correction-target="${focus}"]`,
    );
    if (el && el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-[color:var(--color-warning)]");
      const timer = setTimeout(
        () =>
          el.classList.remove(
            "ring-2",
            "ring-[color:var(--color-warning)]",
          ),
        3500,
      );
      return () => clearTimeout(timer);
    }
  }, [focus]);

  const pending = items.filter((i) => i.resolutionStatus === "pending");
  if (pending.length === 0) return null;

  const headline = (() => {
    switch (section) {
      case "master_details":
        return "CEO flagged master-detail fields";
      case "compliance_documents":
        return "CEO flagged compliance documents";
      case "agreement":
        return "CEO flagged signatories or agreement template";
    }
  })();

  return (
    <div
      data-testid="flagged-items-alert"
      className="rounded-xl border p-4 space-y-2"
      style={{
        background: "var(--color-warning-bg)",
        borderColor: "var(--color-warning)",
        borderLeftWidth: 4,
      }}
    >
      <div className="flex items-start gap-3">
        <AlertCircle
          className="w-5 h-5 shrink-0 mt-0.5"
          style={{ color: "var(--color-warning)" }}
        />
        <div className="min-w-0 flex-1">
          <p
            className="text-sm font-semibold"
            style={{ color: "var(--color-warning)" }}
          >
            {headline} · Round #{roundNumber}
          </p>
          <ul className="mt-2 space-y-1 text-sm text-[color:var(--color-ink)]">
            {pending.map((it) => (
              <li
                key={it.targetKey}
                className="flex items-start gap-2"
              >
                <ArrowDown className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-70" />
                <div>
                  <span className="font-semibold">{it.label}</span>
                  {it.remark && (
                    <span className="text-[color:var(--color-ink-muted)]">
                      {" — "}
                      {it.remark}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
