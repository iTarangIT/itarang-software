"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Acknowledge / resolve buttons for one open alert.
 *
 * The two are different actions and the labels say so: acknowledging leaves the
 * alert OPEN (the condition is still true, it just stops being a surprise),
 * while resolving closes it. A manually resolved alert whose breach is still
 * live will re-open on the next tick — that is correct, and the button's title
 * says as much so nobody reads it as a bug.
 */
export function AlertActions({
  alertId,
  acknowledged,
}: {
  alertId: string;
  acknowledged: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "acknowledge" | "resolve") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/operations/alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: alertId, action }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setError(json?.error?.message ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
      startTransition(() => router.refresh());
    }
  }

  const disabled = busy || isPending;

  return (
    <div className="flex items-center justify-end gap-2">
      {error && (
        <span className="max-w-[12rem] truncate text-[11px] text-danger" title={error}>
          {error}
        </span>
      )}
      {!acknowledged && (
        <button
          type="button"
          onClick={() => act("acknowledge")}
          disabled={disabled}
          title="Mark as seen. The alert stays open while the condition holds."
          className="rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-ink-muted hover:bg-brand-50 disabled:opacity-50"
        >
          Ack
        </button>
      )}
      <button
        type="button"
        onClick={() => act("resolve")}
        disabled={disabled}
        title="Close this alert. It will re-open on the next tick if the breach is still live."
        className="rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-ink-muted hover:bg-brand-50 disabled:opacity-50"
      >
        Resolve
      </button>
    </div>
  );
}
