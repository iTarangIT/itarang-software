"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { MetricOption } from "@/lib/operations/alertsView";

/**
 * Create a per-source threshold override.
 *
 * A rule naming a specific source shadows the '*' rule for that source alone —
 * so this is how you say "80% is fine for every host except the IoT box" or
 * "ElevenLabs needs a different credit floor to the next vendor".
 *
 * Both dropdowns are populated from what is actually reporting. A free-text
 * source box invites a typo like "vendor:eleven_labs", which creates a rule
 * that matches nothing, fires never, and looks entirely correct on the page.
 *
 * The comparator is NOT offered. It encodes "which way is bad", which belongs
 * to the metric in registry.ts; a rule allowed to disagree with its metric would
 * invert the alert while everything on screen still looked right. It is shown,
 * read-only, so the direction is never a surprise.
 */
export function RuleCreator({ options }: { options: MetricOption[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [metricKey, setMetricKey] = useState("");
  const [source, setSource] = useState("");
  const [warn, setWarn] = useState("");
  const [crit, setCrit] = useState("");
  const [cooldown, setCooldown] = useState("60");
  const [email, setEmail] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const metric = useMemo(
    () => options.find((o) => o.metric_key === metricKey) ?? null,
    [options, metricKey],
  );

  function pickMetric(key: string) {
    setMetricKey(key);
    setError(null);
    setState("idle");
    const next = options.find((o) => o.metric_key === key) ?? null;
    // One source means there is nothing to choose; preselect it rather than
    // making an empty dropdown the reason the form will not submit.
    setSource(next?.sources.length === 1 ? next.sources[0]! : "");
    // Seed from the '*' rule so the override starts as a copy of what this
    // source is already judged by, and the operator edits the difference.
    setWarn(next?.default_warn?.toString() ?? "");
    setCrit(next?.default_crit?.toString() ?? "");
  }

  const parse = (value: string): number | null => {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  };

  const warnNum = parse(warn);
  const critNum = parse(crit);
  const ready = metric != null && source !== "" && (warnNum != null || critNum != null);

  async function create() {
    if (!metric) return;
    setState("saving");
    setError(null);
    try {
      const channels: Array<"inapp" | "email"> = ["inapp"];
      if (email) channels.push("email");

      const res = await fetch("/api/operations/alerts/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metric_key: metric.metric_key,
          source,
          warn_threshold: warnNum,
          crit_threshold: critNum,
          cooldown_minutes: Number(cooldown) || 60,
          notify_channels: channels,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setState("error");
        setError(json?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      // Reset and collapse — the new rule appears in the table above.
      setState("idle");
      setMetricKey("");
      setSource("");
      setWarn("");
      setCrit("");
      setOpen(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Request failed");
    }
  }

  const field =
    "h-7 rounded border border-border bg-surface px-1.5 text-[11px] text-ink focus:border-brand-sky focus:outline-none";

  if (options.length === 0) {
    return (
      <p className="mt-3 text-[11px] text-ink-muted">
        No source is reporting a registered metric right now, so there is nothing
        to override. Overrides are offered once a collector has written samples.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 rounded-lg border border-border px-2.5 py-1 text-[11px] font-semibold text-ink-muted hover:bg-brand-50 hover:text-brand-700"
      >
        + Per-source override
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-border p-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold text-ink">
          New per-source override
        </span>
        <span className="text-[10px] text-ink-muted">
          Shadows the <code>*</code> rule for this source only. Every other source
          keeps using <code>*</code>.
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-muted">
            Metric
          </span>
          <select
            value={metricKey}
            onChange={(e) => pickMetric(e.target.value)}
            className={`${field} w-56`}
          >
            <option value="">Choose…</option>
            {options.map((o) => (
              <option key={o.metric_key} value={o.metric_key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-muted">
            Source
          </span>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            disabled={!metric}
            className={`${field} w-52 disabled:opacity-50`}
          >
            <option value="">{metric ? "Choose…" : "Pick a metric first"}</option>
            {metric?.sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-muted">
            Warn
          </span>
          <input
            value={warn}
            onChange={(e) => setWarn(e.target.value)}
            placeholder="none"
            className={`${field} w-20 text-right tabular-nums`}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-muted">
            Crit
          </span>
          <input
            value={crit}
            onChange={(e) => setCrit(e.target.value)}
            placeholder="none"
            className={`${field} w-20 text-right tabular-nums`}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-muted">
            Cooldown
          </span>
          <input
            value={cooldown}
            onChange={(e) => setCooldown(e.target.value)}
            className={`${field} w-16 text-right tabular-nums`}
          />
        </label>

        <label className="flex items-center gap-1.5 pb-1.5 text-[11px] text-ink-muted">
          <input
            type="checkbox"
            checked={email}
            onChange={(e) => setEmail(e.target.checked)}
            className="h-3 w-3 cursor-pointer accent-brand-sky"
          />
          Email
        </label>

        <button
          type="button"
          onClick={create}
          disabled={!ready || state === "saving" || isPending}
          className="mb-0.5 rounded-lg bg-brand-navy px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-40"
        >
          {state === "saving" ? "…" : "Create"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="mb-0.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-semibold text-ink-muted hover:bg-brand-50"
        >
          Cancel
        </button>
      </div>

      {metric && (
        <p className="mt-2 text-[10px] text-ink-muted">
          Fires{" "}
          <strong className="text-ink">
            {metric.comparator === "lt" ? "below" : "above"}
          </strong>{" "}
          the threshold ({metric.comparator}), from the metric&rsquo;s direction —
          not editable. Prefilled from the <code>*</code> rule.
          {metric.help && ` ${metric.help}`}
        </p>
      )}

      {!ready && metric && source !== "" && (
        <p className="mt-2 text-[10px] text-warning">
          Set at least one threshold — an override with neither can never fire,
          and it would shadow <code>*</code> and leave this source unmonitored.
        </p>
      )}

      {state === "error" && (
        <p className="mt-2 text-[10px] text-danger">{error}</p>
      )}
    </div>
  );
}
