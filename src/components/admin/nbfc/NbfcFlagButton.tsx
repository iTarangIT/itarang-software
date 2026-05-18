"use client";

/**
 * E-111 — per-item "Flag for correction" pill button.
 *
 * Rendered next to every flaggable element on the CEO review page. Shows
 * only when the viewer is CEO AND flag mode is on. When already in the
 * pending-flag map, switches to the "Flagged · click to remove" state.
 *
 * Also surfaces a green "Resolved" / amber "Awaiting fix" pill (without
 * needing flag mode) reading from `latestRound`, so previously-flagged
 * items show their state to anyone viewing the page.
 */

import { Flag, FlagOff, CheckCircle2, AlertCircle, MinusCircle } from "lucide-react";
import type { CorrectionKind } from "@/lib/nbfc/admin/correction-catalog";
import {
  compositeKey,
  useOptionalCorrectionFlagContext,
} from "./correction-flag-context";

export interface NbfcFlagButtonProps {
  kind: CorrectionKind;
  targetKey: string;
  targetRefId?: number;
  /** Optional smaller variant for inline use in dense rows. */
  size?: "sm" | "md";
}

export default function NbfcFlagButton({
  kind,
  targetKey,
  targetRefId,
  size = "sm",
}: NbfcFlagButtonProps) {
  const ctx = useOptionalCorrectionFlagContext();
  if (!ctx) return null;
  const { viewerIsCeo, flagMode, pendingFlags, toggleFlag, flaggedItemFor } =
    ctx;

  const resolved = flaggedItemFor(kind, targetKey);
  const isPending = pendingFlags.has(compositeKey(kind, targetKey));

  // Show "Awaiting fix" / "Resolved" / "Dismissed" pills regardless of flag mode.
  const statusPill = resolved
    ? resolved.resolutionStatus === "resolved"
      ? (
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold"
          style={{
            background: "var(--color-success-bg)",
            color: "var(--color-success)",
          }}
          title={
            resolved.remark
              ? `CEO remark: ${resolved.remark}`
              : "Previously flagged — admin has corrected this item."
          }
        >
          <CheckCircle2 className="w-3 h-3" />
          Resolved
        </span>
      )
      : resolved.resolutionStatus === "pending"
        ? (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold"
            style={{
              background: "var(--color-warning-bg)",
              color: "var(--color-warning)",
            }}
            title={
              resolved.remark ?? "CEO flagged this for correction."
            }
          >
            <AlertCircle className="w-3 h-3" />
            Awaiting fix
          </span>
        )
        : (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold"
            style={{
              background: "var(--color-bg)",
              color: "var(--color-ink-muted)",
            }}
            title="Admin marked this item as dismissed without changing it."
          >
            <MinusCircle className="w-3 h-3" />
            Dismissed
          </span>
        )
    : null;

  if (!viewerIsCeo || !flagMode) {
    return statusPill;
  }

  const dimensions =
    size === "md" ? "h-7 px-2.5 text-xs" : "h-6 px-2 text-[11px]";

  return (
    <>
      {statusPill}
      <button
        type="button"
        data-testid={`flag-button-${kind}-${targetKey}`}
        aria-pressed={isPending}
        onClick={() => toggleFlag({ kind, targetKey, targetRefId })}
        className={`inline-flex items-center gap-1 rounded-full border ${dimensions} font-semibold transition-colors`}
        style={
          isPending
            ? {
                background: "var(--color-warning)",
                borderColor: "var(--color-warning)",
                color: "white",
              }
            : {
                background: "transparent",
                borderColor: "var(--color-warning)",
                color: "var(--color-warning)",
              }
        }
      >
        {isPending ? (
          <>
            <FlagOff className="w-3 h-3" />
            Flagged
          </>
        ) : (
          <>
            <Flag className="w-3 h-3" />
            Flag
          </>
        )}
      </button>
    </>
  );
}
