"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { ANY_SOURCE } from "@/lib/operations/alertRouting";
import type { RuleRow } from "@/lib/operations/alertsView";

/**
 * Inline editor for one threshold rule.
 *
 * Only the tunable fields are here. metric_key, source and comparator are not
 * editable: the comparator encodes "which way is bad", which belongs to the
 * metric definition in registry.ts. A rule allowed to disagree with its metric
 * would invert the alert while everything on screen still looked correct.
 *
 * An empty threshold box means "no threshold at this level" — a metric can
 * legitimately warn but never escalate to critical — so blank is sent as null
 * rather than being coerced to 0, which would make everything breach.
 *
 * A rule naming a specific source is an OVERRIDE: it shadows the '*' rule for
 * that source alone. Overrides can be deleted; the '*' rows cannot, because
 * seedAlertRules() would recreate them from the registry defaults on the next
 * tick and quietly discard whatever they had been tuned to.
 */
export function RuleEditor({
  rule,
  shadowedFor = [],
}: {
  rule: RuleRow;
  /** For a '*' rule: sources an override has taken over. */
  shadowedFor?: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const isOverride = rule.source !== ANY_SOURCE;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [warn, setWarn] = useState(rule.warn_threshold?.toString() ?? "");
  const [crit, setCrit] = useState(rule.crit_threshold?.toString() ?? "");
  const [cooldown, setCooldown] = useState(String(rule.cooldown_minutes));
  const [enabled, setEnabled] = useState(rule.enabled);
  const [email, setEmail] = useState(rule.notify_channels.includes("email"));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const parse = (value: string): number | null => {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  };

  async function save() {
    setState("saving");
    setError(null);
    try {
      const channels: Array<"inapp" | "email"> = ["inapp"];
      if (email) channels.push("email");

      const res = await fetch("/api/operations/alerts/rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: rule.id,
          warn_threshold: parse(warn),
          crit_threshold: parse(crit),
          enabled,
          cooldown_minutes: Number(cooldown) || rule.cooldown_minutes,
          notify_channels: channels,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setState("error");
        setError(json?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setState("saved");
      startTransition(() => router.refresh());
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Request failed");
    }
  }

  async function remove() {
    setState("saving");
    setError(null);
    try {
      const res = await fetch("/api/operations/alerts/rules", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setState("error");
        setError(json?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setState("idle");
      startTransition(() => router.refresh());
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Request failed");
    }
  }

  const input =
    "h-7 w-20 rounded border border-border bg-surface px-1.5 text-right text-[11px] tabular-nums text-ink focus:border-brand-sky focus:outline-none";

  return (
    <tr className="border-b border-border/60 align-middle last:border-0">
      <td className="py-2 pr-3">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-ink" title={rule.help}>
            {rule.label}
          </span>
          {isOverride && (
            <span
              className="rounded bg-brand-50 px-1 text-[9px] font-semibold uppercase tracking-wide text-brand-700"
              title="Shadows the '*' rule for this source only"
            >
              override
            </span>
          )}
        </div>
        <div className="font-mono text-[10px] text-ink-muted">
          {rule.metric_key} · {rule.source} · {rule.comparator}
        </div>
        {/* Without this, a '*' rule that has quietly stopped covering a source
            looks identical to one that still does — and "why didn't this fire
            for prod?" becomes a debugging session. */}
        {shadowedFor.length > 0 && (
          <div className="mt-0.5 text-[10px] text-ink-muted">
            not applied to{" "}
            <span className="font-mono">{shadowedFor.join(", ")}</span> — overridden
          </div>
        )}
      </td>
      <td className="py-2 pr-2 text-right">
        <input
          value={warn}
          onChange={(e) => setWarn(e.target.value)}
          placeholder="none"
          className={input}
          aria-label={`Warn threshold for ${rule.label}`}
        />
      </td>
      <td className="py-2 pr-2 text-right">
        <input
          value={crit}
          onChange={(e) => setCrit(e.target.value)}
          placeholder="none"
          className={input}
          aria-label={`Critical threshold for ${rule.label}`}
        />
      </td>
      <td className="py-2 pr-2 text-right">
        <input
          value={cooldown}
          onChange={(e) => setCooldown(e.target.value)}
          className={`${input} w-16`}
          aria-label={`Cooldown minutes for ${rule.label}`}
        />
      </td>
      <td className="py-2 pr-2 text-center">
        <input
          type="checkbox"
          checked={email}
          onChange={(e) => setEmail(e.target.checked)}
          className="h-3 w-3 cursor-pointer accent-brand-sky"
          aria-label={`Email notifications for ${rule.label}`}
        />
      </td>
      <td className="py-2 pr-2 text-center">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-3 w-3 cursor-pointer accent-brand-sky"
          aria-label={`Enabled for ${rule.label}`}
        />
      </td>
      <td className="py-2 text-right">
        <div className="flex items-center justify-end gap-2">
          {state === "error" && (
            <span className="max-w-[10rem] truncate text-[10px] text-danger" title={error ?? ""}>
              {error}
            </span>
          )}
          {state === "saved" && <span className="text-[10px] text-success">saved</span>}
          <button
            type="button"
            onClick={save}
            disabled={state === "saving" || isPending}
            className="rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-ink-muted hover:bg-brand-50 disabled:opacity-50"
          >
            {state === "saving" ? "…" : "Save"}
          </button>
          {/* Overrides only. Two clicks rather than a modal: deleting one is
              recoverable — the source falls straight back to the '*' rule — but
              it should not happen on a mis-click either. */}
          {isOverride &&
            (confirmDelete ? (
              <>
                <button
                  type="button"
                  onClick={remove}
                  disabled={state === "saving" || isPending}
                  className="rounded-lg border border-danger/50 px-2 py-1 text-[11px] font-semibold text-danger hover:bg-danger-bg/40 disabled:opacity-50"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="text-[10px] text-ink-muted hover:text-ink"
                >
                  cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={state === "saving" || isPending}
                className="rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-ink-muted hover:border-danger/50 hover:text-danger disabled:opacity-50"
                title="Delete this override — the source returns to the '*' rule"
              >
                Delete
              </button>
            ))}
        </div>
      </td>
    </tr>
  );
}
