"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export default function RerunButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const onClick = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch("/api/nbfc/risk/run", { method: "POST" });
      const data = (await r.json()) as {
        ok?: boolean;
        cards_generated?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
        error?: string;
      };
      if (!r.ok || data.ok === false) {
        setResult(`Error: ${data.error ?? r.statusText}`);
      } else {
        const tok = (data.prompt_tokens ?? 0) + (data.completion_tokens ?? 0);
        setResult(`${data.cards_generated ?? 0} cards in ${tok.toLocaleString()} tokens`);
        // Re-fetch the server component so the new cards appear
        startTransition(() => router.refresh());
      }
    } catch (e) {
      setResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || isPending;

  return (
    <div className="flex items-center gap-3">
      {result && (
        <span
          className={`text-xs ${
            result.startsWith("Error") ? "text-red-600" : "text-emerald-600"
          }`}
        >
          {result}
        </span>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="px-4 py-2 text-sm font-medium rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
      >
        {disabled && (
          <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
            <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        )}
        {busy ? "Running…" : isPending ? "Refreshing…" : "Re-run analysis"}
      </button>
    </div>
  );
}
