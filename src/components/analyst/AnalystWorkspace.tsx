"use client";

// Data Analyst — the ask screen: the caller's conversations on the left, the transcript and the
// composer on the right. Ported from the agent's own frontend (components/ask/ask-workspace.tsx)
// and fitted into the CRM's dashboard shell, which already has its own sidebar.
//
// Things worth knowing before changing anything here:
//  - A run starts from the submit handler, never an effect (effects double-run in dev, and a
//    run spends the agent's daily token budget).
//  - `turns` is this sitting only. A reload clears it; reopening a thread replays it from the
//    agent as `history`, without result tables (the agent never stores rows).
//  - Every flex/grid ancestor of the result table carries `min-w-0`, or a wide result stretches
//    the page instead of scrolling inside its own box.

import { BarChart3, ChevronDown, Database, MessageSquarePlus, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";

import { buildChart, forecastTable } from "@/lib/analyst/chart";
import { isRunning, type RunState } from "@/lib/analyst/run-types";
import { withAskedThread } from "@/lib/analyst/threads";
import type { Connection, RunSummary, Thread } from "@/lib/analyst/types";
import { cn } from "@/lib/utils";

import { useRun, useTranscriptScroll } from "./hooks";
import {
  AssistantMessage,
  Composer,
  LiveAnswer,
  MessageActions,
  PastTurn,
  ResultTable,
  RunErrorPanel,
  RunProcess,
  RunStatus,
  UserMessage,
} from "./parts";
import { ResultChart } from "./result-chart";

/** Starter questions for an empty conversation. Phrased for what the connected data can answer. */
const SUGGESTIONS = [
  "How many leads were created this month, by status?",
  "Which 10 dealers brought in the most leads in the last 90 days?",
  "Show the monthly trend of converted leads this year",
  "What share of AI calls last week ended with the dealer speaking?",
];

export type AnalystWorkspaceProps = {
  basePath: string;
  threadId: string;
  connections: Connection[];
  history: RunSummary[];
  threads: Thread[];
  /** The agent did not answer (a sleeping Render service takes up to a minute to wake). */
  unreachable: boolean;
  /** Set when the page could not load the agent's data, to say why. */
  problem: string | null;
};

export function AnalystWorkspace({
  basePath,
  threadId,
  connections,
  history,
  threads: initialThreads,
  unreachable,
  problem,
}: AnalystWorkspaceProps) {
  const { state, turns, ask, cancel } = useRun();
  const { viewportRef, contentRef, onSubmit: followSubmittedQuestion } = useTranscriptScroll();
  const [question, setQuestion] = useState("");
  const [threads, setThreads] = useState(initialThreads);
  // A continued thread keeps asking the source it was asking, if that still exists.
  const [connectionId, setConnectionId] = useState(() => {
    const last = history[history.length - 1]?.connection_id;
    return connections.some((c) => c.id === last) ? last : (connections[0]?.id ?? "");
  });

  const busy = isRunning(state.phase);
  const started = state.phase !== "idle";
  const shown = new Set([...turns.map((t) => t.runId), state.runId]);
  const past = history.filter((run) => !shown.has(run.id));
  const empty = !started && turns.length === 0 && past.length === 0;
  const active = connections.find((c) => c.id === connectionId) ?? null;
  // The agent refuses a source whose tables were listed but none chosen.
  const needsTables = active !== null && active.total_tables > 0 && active.selected_tables === 0;
  const ready = connectionId !== "" && !needsTables && !unreachable;
  const canSend = question.trim().length >= 3 && ready && !busy;

  const refreshThreads = useCallback(async () => {
    try {
      const response = await fetch("/api/analyst/threads", { cache: "no-store" });
      if (response.ok) setThreads((await response.json()) as Thread[]);
    } catch {
      // The optimistic row stays; the next page load corrects it.
    }
  }, []);

  async function send(asked: string) {
    followSubmittedQuestion();

    // The thread id goes into the address bar so a reload comes back to it. Replaced, not
    // pushed: Back should leave the chat, not un-ask the question.
    const url = new URL(window.location.href);
    if (url.searchParams.get("thread") !== threadId) {
      url.searchParams.set("thread", threadId);
      window.history.replaceState(null, "", url);
    }

    setThreads((current) =>
      withAskedThread(current, { threadId, question: asked, connectionId, at: new Date().toISOString() }),
    );
    await ask({ connectionId, question: asked, threadId });
    void refreshThreads();
  }

  function submit(text = question) {
    const asked = text.trim();
    if (asked.length < 3 || !ready || busy) return;
    setQuestion("");
    void send(asked);
  }

  const askAgain = ready && !busy ? (asked: string) => () => void send(asked) : null;

  return (
    <div className="flex h-[calc(100dvh-10rem)] min-h-[32rem] min-w-0 overflow-hidden rounded-xl border border-border bg-surface shadow-card">
      <ThreadColumn basePath={basePath} threads={threads} activeId={threadId} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles aria-hidden className="size-4 shrink-0 text-brand-500" />
            <h1 className="truncate text-[0.9375rem] font-semibold text-ink">AI Analyst</h1>
            <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[0.6875rem] font-medium text-brand-700">
              Beta
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-1">
            {unreachable ? null : (
              <ConnectionPicker connections={connections} value={connectionId} onChange={setConnectionId} active={active} />
            )}
            <Link
              href={basePath}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem] font-medium text-ink-muted transition-colors hover:bg-bg hover:text-ink lg:hidden"
            >
              <MessageSquarePlus aria-hidden className="size-4" />
              New
            </Link>
          </div>
        </header>

        <div
          ref={viewportRef}
          className={cn("min-h-0 overflow-y-auto [overflow-anchor:none]", empty ? "flex flex-1 flex-col justify-end" : "flex-1")}
        >
          <div ref={contentRef} className="mx-auto w-full max-w-3xl px-4 sm:px-6">
            {empty ? (
              <Welcome
                connections={connections}
                active={active}
                unreachable={unreachable}
                problem={problem}
                onPick={ready && !busy ? (s) => submit(s) : null}
              />
            ) : (
              <div className="flex flex-col gap-10 pt-6 pb-12">
                {past.map((run, i) => (
                  <PastTurn
                    key={run.id}
                    run={run}
                    latest={!started && turns.length === 0 && i === past.length - 1}
                    onAskAgain={askAgain?.(run.question)}
                  />
                ))}
                {turns.map((turn, i) => (
                  <Turn
                    key={(turn.runId ?? "turn") + "-" + i}
                    turn={turn}
                    latest={!started && i === turns.length - 1}
                    onAskAgain={turn.question ? askAgain?.(turn.question) : undefined}
                  />
                ))}
                {started ? (
                  <Turn turn={state} live latest onAskAgain={state.question ? askAgain?.(state.question) : undefined} />
                ) : null}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 px-3 pt-2 pb-3 sm:px-6">
          <div className="mx-auto w-full max-w-3xl">
            {needsTables && active ? (
              <p className="mb-2 text-center text-[0.8125rem] text-warning">
                No tables are chosen for {active.name} yet — choose them in the analyst&rsquo;s admin console first.
              </p>
            ) : null}
            <Composer
              value={question}
              onChange={setQuestion}
              onSubmit={() => submit()}
              onStop={cancel}
              busy={busy}
              canSend={canSend}
              disabled={!ready && !busy}
              placeholder={
                unreachable
                  ? "Waiting for the analyst service"
                  : connections.length === 0
                    ? "No data source is connected yet"
                    : needsTables
                      ? "Choose which tables the analyst may read first"
                      : empty
                        ? "Ask anything about your data"
                        : "Ask a follow-up"
              }
            />
          </div>
        </div>

        {/* Balances the space above the welcome, which is what centres the composer. */}
        {empty ? <div aria-hidden className="flex-1" /> : null}
      </div>
    </div>
  );
}

/** One question and everything the agent handed back for it. */
function Turn({
  turn,
  live,
  latest,
  onAskAgain,
}: {
  turn: RunState;
  live?: boolean;
  latest: boolean;
  onAskAgain?: () => void;
}) {
  const running = isRunning(turn.phase);
  // Ask before laying out: a chart that cannot be drawn honestly renders nothing, and the
  // table should not leave a gap where it was going to be.
  const plottable = turn.chart !== null && turn.result !== null && buildChart(turn.chart, turn.result).kind !== "none";
  const forecast = turn.chart ? forecastTable(turn.chart) : null;

  return (
    <div className="flex flex-col gap-5">
      <UserMessage>{turn.question}</UserMessage>
      <AssistantMessage>
        {running ? <RunStatus state={turn} /> : null}
        {turn.answer ? <LiveAnswer text={turn.answer} live={Boolean(live)} /> : null}
        {plottable && turn.chart && turn.result ? <ResultChart spec={turn.chart} result={turn.result} /> : null}
        {forecast ? <ResultTable result={forecast} /> : null}
        {turn.result ? <ResultTable result={turn.result} /> : null}
        {turn.error ? <RunErrorPanel error={turn.error} /> : null}
        {turn.phase === "cancelled" ? <p className="text-[0.875rem] text-ink-muted">You stopped this run.</p> : null}
        {running ? null : (
          <MessageActions copyText={turn.answer} onAskAgain={onAskAgain} persistent={latest}>
            <RunProcess state={turn} />
          </MessageActions>
        )}
      </AssistantMessage>
    </div>
  );
}

function ThreadColumn({ basePath, threads, activeId }: { basePath: string; threads: Thread[]; activeId: string }) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-bg/60 lg:flex">
      <div className="p-3">
        <Link
          href={basePath}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-3 py-2 text-[0.8125rem] font-medium text-white transition-colors hover:bg-brand-600"
        >
          <MessageSquarePlus aria-hidden className="size-4" />
          New conversation
        </Link>
      </div>
      <p className="px-4 pt-1 pb-2 text-[0.6875rem] font-semibold tracking-wide text-ink-muted uppercase">
        Your conversations
      </p>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {threads.length === 0 ? (
          <p className="px-2 py-2 text-[0.8125rem] text-ink-muted">Nothing yet. Ask your first question.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {threads.map((thread) => (
              <li key={thread.thread_id}>
                <Link
                  href={`${basePath}?thread=${encodeURIComponent(thread.thread_id)}`}
                  title={thread.title}
                  aria-current={thread.thread_id === activeId ? "page" : undefined}
                  className={cn(
                    "block truncate rounded-lg px-2.5 py-2 text-[0.8125rem] transition-colors",
                    thread.thread_id === activeId
                      ? "bg-brand-50 font-medium text-brand-800"
                      : "text-ink hover:bg-surface",
                  )}
                >
                  {thread.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </aside>
  );
}

/** A native select laid over a label: the platform's own picker and keyboard handling. */
function ConnectionPicker({
  connections,
  value,
  onChange,
  active,
}: {
  connections: Connection[];
  value: string;
  onChange: (id: string) => void;
  active: Connection | null;
}) {
  if (connections.length === 0) return null;
  const many = connections.length > 1;
  return (
    <div
      className={cn(
        "relative inline-flex min-w-0 items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-[0.8125rem] font-medium text-ink",
        many && "transition-colors focus-within:ring-2 focus-within:ring-brand-100 hover:bg-bg",
      )}
    >
      <Database aria-hidden className="size-4 shrink-0 text-ink-muted" strokeWidth={1.75} />
      <span className="max-w-[12rem] truncate">{active?.name}</span>
      {many ? (
        <>
          <ChevronDown aria-hidden className="size-4 shrink-0 text-ink-muted" strokeWidth={2} />
          <select
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-label="Data source"
            className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0"
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </>
      ) : null}
    </div>
  );
}

function Welcome({
  connections,
  active,
  unreachable,
  problem,
  onPick,
}: {
  connections: Connection[];
  active: Connection | null;
  unreachable: boolean;
  problem: string | null;
  onPick: ((question: string) => void) | null;
}) {
  const router = useRouter();
  // A refresh re-runs the page's reads, which is the whole retry.
  const [retrying, startRetry] = useTransition();

  return (
    <div className="flex flex-col items-center pb-8 text-center">
      <span className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-brand-50">
        <BarChart3 aria-hidden className="size-7 text-brand-500" />
      </span>

      {problem ? (
        <>
          <h2 className="text-xl font-semibold text-ink">The analyst isn&rsquo;t available</h2>
          <p className="mt-2 max-w-[52ch] text-[0.9375rem] leading-relaxed text-ink-muted">{problem}</p>
        </>
      ) : unreachable ? (
        <>
          <h2 className="text-xl font-semibold text-ink">The analyst service is waking up</h2>
          <p className="mt-2 max-w-[46ch] text-[0.9375rem] leading-relaxed text-ink-muted">
            It sleeps when idle and can take up to a minute to start. Try again in a moment.
          </p>
          <button
            type="button"
            disabled={retrying}
            onClick={() => startRetry(() => router.refresh())}
            className="mt-5 rounded-full bg-brand-500 px-4 py-2 text-[0.875rem] font-medium text-white transition-colors hover:bg-brand-600 disabled:opacity-60"
          >
            {retrying ? "Trying again…" : "Try again"}
          </button>
        </>
      ) : connections.length === 0 ? (
        <>
          <h2 className="text-xl font-semibold text-ink">No data source is connected yet</h2>
          <p className="mt-2 max-w-[52ch] text-[0.9375rem] leading-relaxed text-ink-muted">
            An admin needs to connect a read-only database to the analyst before questions can be asked.
          </p>
        </>
      ) : (
        <>
          <h2 className="text-xl font-semibold text-balance text-ink sm:text-2xl">
            What do you want to know about {active?.name ?? "your data"}?
          </h2>
          <p className="mt-2 max-w-[54ch] text-[0.9375rem] leading-relaxed text-ink-muted">
            Ask in plain English. The analyst writes the SQL, checks it is read-only, runs it, and shows the query
            behind every answer.
          </p>
          <div className="mt-6 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                disabled={!onPick}
                onClick={() => onPick?.(s)}
                className="rounded-xl border border-border bg-surface px-3.5 py-2.5 text-left text-[0.8125rem] text-ink transition-colors hover:border-brand-300 hover:bg-brand-50 disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
