"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

/**
 * "Run now" for a single collector.
 *
 * Runs it out of band, ignoring its intervalMs. The single-flight lock still
 * applies server-side, so pressing this while the ticker is mid-run answers 409
 * rather than starting a second concurrent run — the button reports that as
 * "already running", which is the truth rather than an error.
 *
 * The outcome is kept on screen until the next action. A collector that failed
 * two seconds ago and a collector that has never run look identical in the
 * table until it refreshes, and "nothing visibly happened" is the one response
 * a diagnostic button must never give.
 */
export function RunCollectorButton({
  collectorId,
  inFlight,
}: {
  collectorId: string;
  inFlight: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{
    tone: "ok" | "warn" | "bad";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/operations/jobs/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collector_id: collectorId }),
      });
      const json = await res.json().catch(() => null);

      if (res.status === 409) {
        setResult({ tone: "warn", text: "Already running" });
      } else if (!res.ok || !json?.success) {
        setResult({
          tone: "bad",
          text: json?.error?.message ?? `HTTP ${res.status}`,
        });
      } else if (json.data?.status === "failed") {
        setResult({ tone: "bad", text: json.data.error ?? "Failed" });
      } else {
        setResult({
          tone: "ok",
          text: `Wrote ${json.data?.samples ?? 0} samples`,
        });
      }
    } catch (e) {
      // A network failure here usually means the app itself is the thing that
      // is down, which is worth saying out loud on a monitoring page.
      setResult({
        tone: "bad",
        text: e instanceof Error ? e.message : "Request failed",
      });
    } finally {
      setBusy(false);
      // Re-render the server component so the row picks up the new run.
      startTransition(() => router.refresh());
    }
  }

  const disabled = busy || isPending || inFlight;

  return (
    <div className="flex items-center justify-end gap-2">
      {result && (
        <span
          className={
            result.tone === "ok"
              ? "max-w-[16rem] truncate text-[11px] text-success"
              : result.tone === "warn"
                ? "max-w-[16rem] truncate text-[11px] text-warning"
                : "max-w-[16rem] truncate text-[11px] text-danger"
          }
          title={result.text}
        >
          {result.text}
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={run}
        disabled={disabled}
        title={
          inFlight
            ? "This collector is already running"
            : `Run ${collectorId} now`
        }
      >
        {busy ? "Running…" : inFlight ? "Running" : "Run now"}
      </Button>
    </div>
  );
}
