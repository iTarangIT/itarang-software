"use client";

// E-380 — thumbs up / down on an answer. The workspace loads the caller's ratings for the open
// conversation once (FeedbackProvider); each answer's thumbs read and write through it. A
// thumbs-down asks, optionally, what was wrong — that note is what the CEO's review queue reads.

import { ThumbsDown, ThumbsUp } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

type Rating = "up" | "down";
type MyRating = { rating: Rating; comment: string | null };

type FeedbackApi = {
  enabled: boolean;
  ratings: Record<string, MyRating>;
  rate: (runId: string, rating: Rating | null, comment?: string | null) => Promise<boolean>;
};

const FeedbackContext = createContext<FeedbackApi | null>(null);

export function FeedbackProvider({ threadId, children }: { threadId: string; children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const [ratings, setRatings] = useState<Record<string, MyRating>>({});

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/analyst/feedback?thread_id=${encodeURIComponent(threadId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { enabled: boolean; ratings: Record<string, MyRating> };
        setEnabled(body.enabled);
        setRatings(body.ratings ?? {});
      })
      .catch(() => {
        // No thumbs is the safe failure: answers still read fine.
      });
    return () => controller.abort();
  }, [threadId]);

  const rate = useCallback(
    async (runId: string, rating: Rating | null, comment: string | null = null) => {
      const before = ratings[runId];
      setRatings((current) => {
        const next = { ...current };
        if (rating) next[runId] = { rating, comment };
        else delete next[runId];
        return next;
      });
      try {
        const response = await fetch("/api/analyst/feedback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ run_id: runId, thread_id: threadId, rating, comment }),
        });
        if (!response.ok) throw new Error("failed");
        return true;
      } catch {
        setRatings((current) => {
          const next = { ...current };
          if (before) next[runId] = before;
          else delete next[runId];
          return next;
        });
        return false;
      }
    },
    [ratings, threadId],
  );

  return <FeedbackContext.Provider value={{ enabled, ratings, rate }}>{children}</FeedbackContext.Provider>;
}

/** The two thumbs for one answer. Renders nothing outside a provider or before E-380 is applied. */
export function FeedbackButtons({ runId }: { runId: string | null | undefined }) {
  const api = useContext(FeedbackContext);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState(false);

  if (!api?.enabled || !runId) return null;
  const mine = api.ratings[runId]?.rating ?? null;

  async function press(rating: Rating) {
    setFailed(false);
    if (mine === rating) {
      setAsking(false);
      setFailed(!(await api!.rate(runId!, null)));
      return;
    }
    const ok = await api!.rate(runId!, rating);
    setFailed(!ok);
    setAsking(ok && rating === "down");
  }

  async function sendNote() {
    const ok = await api!.rate(runId!, "down", note.trim() || null);
    setFailed(!ok);
    if (ok) {
      setAsking(false);
      setNote("");
    }
  }

  return (
    <>
      <ThumbButton label="Good answer" pressed={mine === "up"} onClick={() => void press("up")}>
        <ThumbsUp className="size-4" strokeWidth={1.75} />
      </ThumbButton>
      <ThumbButton label="Wrong or unhelpful answer" pressed={mine === "down"} onClick={() => void press("down")}>
        <ThumbsDown className="size-4" strokeWidth={1.75} />
      </ThumbButton>
      {failed ? <span className="px-1 text-[0.75rem] text-danger">Could not save that.</span> : null}
      {asking ? (
        <form
          className="flex w-full items-center gap-2 pt-1 pl-2"
          onSubmit={(e) => {
            e.preventDefault();
            void sendNote();
          }}
        >
          <input
            autoFocus
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What was wrong? (optional) e.g. wrong person, wrong period"
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[0.8125rem] text-ink placeholder:text-ink-muted focus:border-brand-300 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-lg bg-brand-500 px-2.5 py-1.5 text-[0.8125rem] font-medium text-white hover:bg-brand-600"
          >
            Send
          </button>
          <button
            type="button"
            onClick={() => setAsking(false)}
            className="rounded-lg px-2 py-1.5 text-[0.8125rem] text-ink-muted hover:bg-bg hover:text-ink"
          >
            Skip
          </button>
        </form>
      ) : null}
    </>
  );
}

function ThumbButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-bg",
        pressed ? "text-brand-600" : "text-ink-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
