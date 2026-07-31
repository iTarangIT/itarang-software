"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export default function RunScanButton({ inFlight }: { inFlight: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(inFlight);
  const [result, setResult] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (inFlight) startPolling();
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  const startPolling = () => {
    setBusy(true);
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch("/api/it/security/scan/status", { cache: "no-store" });
        const d = (await r.json()) as { in_flight?: boolean; status?: string; findings_total?: number };
        if (!d.in_flight) {
          stopPolling();
          setBusy(false);
          if (d.status === "completed") setResult(`${d.findings_total ?? 0} finding(s)`);
          else if (d.status === "failed") setResult("Scan failed — see logs");
          router.refresh();
        }
      } catch {
        /* keep polling */
      }
    }, 4000);
  };

  const onClick = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch("/api/it/security/scan/run", { method: "POST" });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; hint?: string };
      if (r.status === 409) {
        setResult("Scan already running");
        startPolling();
        return;
      }
      if (!r.ok || d.ok === false) {
        setBusy(false);
        setResult(d.hint ?? d.error ?? `Error ${r.status}`);
        return;
      }
      startPolling();
    } catch (e) {
      setBusy(false);
      setResult(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex items-center gap-3">
      {result && (
        <span className={`text-xs ${/error|fail/i.test(result) ? "text-red-600" : "text-emerald-600"}`}>
          {result}
        </span>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="px-4 py-2 text-sm font-medium rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
      >
        {busy && (
          <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
            <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        )}
        {busy ? "Scanning…" : "Run Scan"}
      </button>
    </div>
  );
}
