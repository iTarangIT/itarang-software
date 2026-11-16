"use client";

// 251 item 23 — "Email me this every morning". The envelope under an answer adds that
// question to the person's morning list (E-385, up to five); pressed again it stops. The
// header's envelope lists the morning questions with a Stop on each. The mail itself is the
// analyst_daily digest, sent at 09:00 IST.

import { Mail, MailCheck, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export type DailyItem = { id: string; question: string; source_run_id: string | null };

type DailyApi = {
  items: DailyItem[];
  max: number;
  add: (runId: string) => Promise<string | null>;
  stop: (id: string) => Promise<boolean>;
};

const DailyContext = createContext<DailyApi | null>(null);

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function DailyProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const [items, setItems] = useState<DailyItem[]>([]);
  const [max, setMax] = useState(5);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch("/api/analyst/daily", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { items: DailyItem[]; max: number };
        setItems(body.items ?? []);
        if (body.max) setMax(body.max);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [enabled]);

  /** Null when added; otherwise what went wrong, in words. */
  const add = useCallback(async (runId: string) => {
    try {
      const response = await fetch("/api/analyst/daily", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: runId }),
      });
      const body = (await response.json().catch(() => ({}))) as { item?: DailyItem; error?: string };
      if (!response.ok || !body.item) return body.error ?? "Could not add that question.";
      const item = body.item;
      setItems((current) => (current.some((i) => i.id === item.id) ? current : [...current, item]));
      return null;
    } catch {
      return "Could not add that question.";
    }
  }, []);

  const stop = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/analyst/daily?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) return false;
      setItems((current) => current.filter((i) => i.id !== id));
      return true;
    } catch {
      return false;
    }
  }, []);

  if (!enabled) return <>{children}</>;
  return <DailyContext.Provider value={{ items, max, add, stop }}>{children}</DailyContext.Provider>;
}

/** The morning-list entry for this answer: the one pressed on it, or the same question asked again. */
function entryFor(api: DailyApi, runId: string, question: string | null | undefined): DailyItem | null {
  return (
    api.items.find((i) => i.source_run_id === runId) ??
    (question ? api.items.find((i) => same(i.question, question)) : undefined) ??
    null
  );
}

/** The envelope under a finished answer. */
export function DailyButton({ runId, question }: { runId: string | null | undefined; question?: string | null }) {
  const api = useContext(DailyContext);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!api || !runId) return null;
  const entry = entryFor(api, runId, question);

  async function toggle() {
    setBusy(true);
    setProblem(null);
    if (entry) {
      if (!(await api!.stop(entry.id))) setProblem("Could not stop it.");
    } else {
      setProblem(await api!.add(runId!));
    }
    setBusy(false);
  }

  const full = !entry && api.items.length >= api.max;
  const label = entry ? "Stop emailing this every morning" : "Email me this every morning";
  return (
    <>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy || full}
        aria-label={label}
        aria-pressed={Boolean(entry)}
        title={
          entry
            ? "You get this question's fresh answer by email at 09:00 every morning. Press to stop."
            : full
              ? `You already get ${api.max} questions every morning. Stop one from the envelope at the top first.`
              : "Email me this question's fresh answer every morning at 09:00"
        }
        className={cn(
          "flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-bg disabled:opacity-40",
          entry ? "text-brand-700" : "text-ink-muted hover:text-ink",
        )}
      >
        {entry ? (
          <MailCheck aria-hidden className="size-4" strokeWidth={1.75} />
        ) : (
          <Mail aria-hidden className="size-4" strokeWidth={1.75} />
        )}
      </button>
      {problem ? <span className="px-1 text-[0.75rem] text-danger">{problem}</span> : null}
    </>
  );
}

/** The header envelope: the person's morning questions, each with a Stop. Hidden when empty. */
export function DailyMenu() {
  const api = useContext(DailyContext);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!api || api.items.length === 0) return null;
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Your morning email questions"
        title="Questions emailed to you every morning"
        className="flex h-8 items-center gap-1 rounded-lg px-2 text-[0.8125rem] text-ink-muted transition-colors hover:bg-bg hover:text-ink"
      >
        <MailCheck aria-hidden className="size-4" strokeWidth={1.75} />
        <span className="tabular-nums">{api.items.length}</span>
      </button>
      {open ? (
        <div className="absolute right-0 top-9 z-30 w-80 rounded-xl border border-border bg-surface p-3 shadow-card">
          <p className="text-[0.75rem] font-semibold text-ink">Emailed to you every morning at 09:00</p>
          <ul className="mt-2 space-y-1.5">
            {api.items.map((item) => (
              <li key={item.id} className="flex items-start gap-2 text-[0.8125rem] text-ink">
                <span className="min-w-0 flex-1 break-words">{item.question}</span>
                <button
                  type="button"
                  onClick={() => void api.stop(item.id)}
                  aria-label={`Stop emailing: ${item.question}`}
                  title="Stop emailing this"
                  className="flex size-6 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-bg hover:text-danger"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[0.6875rem] text-ink-muted">
            Up to {api.max}. Add one with the envelope under any answer.
          </p>
        </div>
      ) : null}
    </div>
  );
}
