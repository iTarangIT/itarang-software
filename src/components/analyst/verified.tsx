"use client";

// E-382 — the "Verified" badge on an answer whose query is a verified one, and the control the
// CEO / Sales Head use to mark a query verified (or take it back). One provider per open
// conversation keeps every answer's mark, so verifying one answer updates every answer that
// ran the same query.

import { BadgeCheck, ShieldCheck, ShieldOff } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

export type VerifiedMark = { id: string; question: string };

type VerifiedApi = {
  enabled: boolean;
  canVerify: boolean;
  marks: Record<string, VerifiedMark | null>;
  note: (runId: string, mark: VerifiedMark | null) => void;
  verify: (runId: string) => Promise<boolean>;
  unverify: (runId: string, id: string) => Promise<boolean>;
};

const VerifiedContext = createContext<VerifiedApi | null>(null);

export function VerifiedProvider({
  enabled,
  canVerify,
  children,
}: {
  enabled: boolean;
  canVerify: boolean;
  children: React.ReactNode;
}) {
  const [marks, setMarks] = useState<Record<string, VerifiedMark | null>>({});

  const note = useCallback((runId: string, mark: VerifiedMark | null) => {
    setMarks((current) => (current[runId]?.id === mark?.id && runId in current ? current : { ...current, [runId]: mark }));
  }, []);

  const verify = useCallback(async (runId: string) => {
    try {
      const response = await fetch("/api/analyst/verified", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: runId }),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { verified: VerifiedMark };
      setMarks((current) => ({ ...current, [runId]: body.verified }));
      return true;
    } catch {
      return false;
    }
  }, []);

  const unverify = useCallback(async (runId: string, id: string) => {
    try {
      const response = await fetch(`/api/analyst/verified?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) return false;
      // Every answer that ran this query loses the badge, not only the one pressed.
      setMarks((current) => {
        const next = { ...current, [runId]: null };
        for (const key of Object.keys(next)) if (next[key]?.id === id) next[key] = null;
        return next;
      });
      return true;
    } catch {
      return false;
    }
  }, []);

  return (
    <VerifiedContext.Provider value={{ enabled, canVerify, marks, note, verify, unverify }}>
      {children}
    </VerifiedContext.Provider>
  );
}

/**
 * Learn a live answer's mark once it has finished (the run detail carries it). Past answers
 * pass the mark they loaded with instead.
 */
export function useVerifiedMark(runId: string | null | undefined, finished: boolean, known?: VerifiedMark | null) {
  const api = useContext(VerifiedContext);
  const note = api?.note;
  const enabled = api?.enabled ?? false;

  useEffect(() => {
    if (!note || !runId) return;
    if (known !== undefined) {
      note(runId, known);
      return;
    }
    if (!enabled || !finished) return;
    const controller = new AbortController();
    fetch(`/api/analyst/runs/${encodeURIComponent(runId)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { verified?: VerifiedMark | null };
        note(runId, body.verified ?? null);
      })
      .catch(() => {
        // No badge is the safe failure.
      });
    return () => controller.abort();
  }, [note, enabled, runId, finished, known]);

  return runId ? (api?.marks[runId] ?? null) : null;
}

/** The green "Verified" pill beside an answer's actions. */
export function VerifiedBadge({ mark }: { mark: VerifiedMark | null }) {
  if (!mark) return null;
  return (
    <span
      title={`This answer used a verified query (checked for: “${mark.question}”)`}
      className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-[0.75rem] font-medium text-success"
    >
      <BadgeCheck aria-hidden className="size-3.5" strokeWidth={2} />
      Verified
    </span>
  );
}

/** Mark / unmark this answer's query as verified. CEO / Sales Head / admin, answers with SQL only. */
export function VerifyButton({ runId, hasSql }: { runId: string | null | undefined; hasSql: boolean }) {
  const api = useContext(VerifiedContext);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!api?.enabled || !api.canVerify || !runId || !hasSql) return null;
  const mark = api.marks[runId] ?? null;

  async function toggle() {
    setBusy(true);
    setFailed(false);
    const ok = mark ? await api!.unverify(runId!, mark.id) : await api!.verify(runId!);
    setFailed(!ok);
    setBusy(false);
  }

  const label = mark ? "Remove verification of this query" : "Mark this query as verified";
  return (
    <>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-label={label}
        title={
          mark
            ? label
            : "Mark this query as verified: similar questions will reuse it and show a Verified badge"
        }
        className={cn(
          "flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-bg disabled:opacity-40",
          mark ? "text-success" : "text-ink-muted hover:text-ink",
        )}
      >
        {mark ? (
          <ShieldOff aria-hidden className="size-4" strokeWidth={1.75} />
        ) : (
          <ShieldCheck aria-hidden className="size-4" strokeWidth={1.75} />
        )}
      </button>
      {failed ? <span className="px-1 text-[0.75rem] text-danger">Could not save that.</span> : null}
    </>
  );
}
