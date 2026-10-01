"use client";

// Data Analyst — client hooks for the ask screen. Ported from the agent's own frontend
// (features/ask/use-run.ts, use-transcript-scroll.ts, use-typed-answer.ts).

import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";

import { runReducer } from "@/lib/analyst/run-machine";
import { IDLE_RUN, type RunEvent, type RunState } from "@/lib/analyst/run-types";
import { readSseStream } from "@/lib/analyst/sse-stream";

const TERMINAL_EVENTS = new Set(["done", "error"]);

export type UseRun = {
  /** The run happening now, or the last one to settle. */
  state: RunState;
  /** Earlier turns in this sitting, oldest first. Never includes `state`. */
  turns: RunState[];
  ask: (input: { connectionId: string; question: string; threadId: string }) => Promise<void>;
  cancel: () => void;
};

/**
 * Drive one run and keep the earlier ones on screen.
 *
 * Started from the submit handler, never an effect: React double-invokes effects in
 * development and every run spends the agent's daily token budget.
 */
export function useRun(): UseRun {
  const [state, dispatch] = useReducer(runReducer, IDLE_RUN);
  const [turns, setTurns] = useState<RunState[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const ask = useCallback<UseRun["ask"]>(
    async ({ connectionId, question, threadId }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Archive what is on screen before the reducer clears it — a failed or stopped turn too,
      // or the transcript reads as though the question was never asked.
      if (state.phase !== "idle") setTurns((current) => [...current, state]);

      dispatch({ type: "@submit", question, connectionId, threadId });

      let response: Response;
      try {
        response = await fetch("/api/analyst/runs", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({ connection_id: connectionId, thread_id: threadId, question }),
          signal: controller.signal,
        });
      } catch {
        dispatch(
          controller.signal.aborted
            ? { type: "@abort" }
            : { type: "@transport", message: "could not reach the server" },
        );
        return;
      }

      // Everything that fails before the stream opens is a status, not an event.
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
        dispatch({
          type: "@http",
          status: response.status,
          message: body.error ?? "that question could not be run",
          code: body.code,
        });
        return;
      }

      dispatch({ type: "@open" });

      const outcome = await readSseStream(
        response.body,
        ({ event, data }) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            return; // one unreadable frame is not worth failing the run over
          }
          dispatch({ type: event, data: parsed } as RunEvent);
          if (TERMINAL_EVENTS.has(event)) return "stop";
        },
        controller.signal,
      );

      // `complete` needs nothing: the terminal event already moved the machine.
      if (outcome.kind === "aborted") dispatch({ type: "@abort" });
      else if (outcome.kind === "transport") dispatch({ type: "@transport", message: outcome.message });
      else if (outcome.kind === "closed") dispatch({ type: "@closed" });
    },
    [state],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  // Leaving the page stops the run rather than streaming into nothing.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { state, turns, ask, cancel };
}

// ── Scroll: follow the answer as it grows, unless the reader scrolled up ──────

const BOTTOM_THRESHOLD = 48;

export function useTranscriptScroll() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastScrollTop = useRef(0);
  const frame = useRef<number | null>(null);

  const followBottom = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const viewport = viewportRef.current;
      if (viewport && following.current) {
        viewport.scrollTop = viewport.scrollHeight;
        lastScrollTop.current = viewport.scrollTop;
      }
    });
  }, []);

  const onSubmit = useCallback(() => {
    following.current = true;
    followBottom();
  }, [followBottom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    lastScrollTop.current = viewport.scrollTop;
    const onScroll = () => {
      const nearBottom =
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= BOTTOM_THRESHOLD;
      if (nearBottom) following.current = true;
      else if (viewport.scrollTop < lastScrollTop.current) following.current = false;
      lastScrollTop.current = viewport.scrollTop;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(followBottom);
    observer.observe(content);
    observer.observe(viewport);
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [followBottom]);

  return { viewportRef, contentRef, onSubmit };
}

// ── Motion ────────────────────────────────────────────────────────────────────

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
const mediaSupported = () => typeof window !== "undefined" && typeof window.matchMedia === "function";

function subscribeReduced(callback: () => void) {
  if (!mediaSupported()) return () => {};
  const media = window.matchMedia(REDUCED_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => mediaSupported() && window.matchMedia(REDUCED_QUERY).matches,
    // The server cannot know, so it assumes the quiet version; hydration corrects it.
    () => true,
  );
}

/** Types a freshly arrived answer out word by word. Presentation only. */
export function useTypedAnswer(text: string, enabled: boolean): string {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState("");
  const progress = useRef({ source: "", shown: "" });

  useEffect(() => {
    const previous = progress.current;
    const prefix = text.startsWith(previous.source) ? previous.shown : "";
    if (!enabled || reduced) {
      progress.current = { source: text, shown: text };
      const timer = setTimeout(() => setShown(text), 0);
      return () => clearTimeout(timer);
    }
    progress.current = { source: text, shown: prefix };
    if (prefix === text) {
      const timer = setTimeout(() => setShown(text), 0);
      return () => clearTimeout(timer);
    }

    const words = text.slice(prefix.length).match(/\s*\S+\s*|\s+/g) ?? [];
    const duration = Math.min(words.length * 30, 1500);
    const start = Date.now();
    const timer = setInterval(() => {
      const count = Math.min(words.length, Math.floor(((Date.now() - start) / duration) * words.length));
      const value = prefix + words.slice(0, count).join("");
      progress.current = { source: text, shown: value };
      setShown(value);
      if (count === words.length) clearInterval(timer);
    }, 15);
    return () => clearInterval(timer);
  }, [text, enabled, reduced]);

  if (!enabled || reduced) return text;
  return text.startsWith(shown) ? shown : "";
}
