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

import { CRM_SOURCE_NAME } from "@/lib/analyst/sources-routes";
import { BadgeCheck, BarChart3, ChevronDown, Database, FileSpreadsheet, History, MessageSquarePlus, MessageSquareWarning, Plus, Settings2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

import { buildChart, forecastTable } from "@/lib/analyst/chart";
import { isRunning, type RunState } from "@/lib/analyst/run-types";
import { ANALYST_QUESTION_MAX } from "@/lib/analyst/questionLimit";
import type { Starter } from "@/lib/analyst/starters";
import type { ListThread } from "@/lib/analyst/threadList";
import { withAskedThread } from "@/lib/analyst/threads";
import type { Connection, RunSummary } from "@/lib/analyst/types";
import { cn } from "@/lib/utils";

import { ConversationTitle, ShareMenu } from "./conversation";
import { FeedbackProvider } from "./feedback";
import { useRun, useTranscriptScroll } from "./hooks";
import {
  AssistantMessage,
  Composer,
  FollowUps,
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
import { sourcesApi } from "./sources/api";
import { SourcesPanel, type PanelView } from "./sources/SourcesPanel";
import { ThreadColumn, type ThreadActions } from "./ThreadColumn";
import { DailyMenu, DailyProvider } from "./daily";
import { useVerifiedMark, VerifiedProvider } from "./verified";

/** What the CRM keeps about the open conversation (E-381). */
export type CurrentThread = { title: string; pinned: boolean; archived: boolean; shared: boolean };

export type AnalystWorkspaceProps = {
  basePath: string;
  threadId: string;
  connections: Connection[];
  history: RunSummary[];
  threads: ListThread[];
  /** Item 12 — starter questions, the caller's own most-asked first (lib/analyst/starters.ts). */
  starters: Starter[];
  /** The open conversation, when it is one of the caller's existing ones. */
  current?: CurrentThread | null;
  /** E-381 is applied: rename / pin / archive / delete / share. */
  threadsEnabled?: boolean;
  /** E-382 is applied: verified badges. */
  verifiedEnabled?: boolean;
  /** E-385 is applied: the morning-email envelope shows (251 item 23). */
  dailyEnabled?: boolean;
  /** CEO / Sales Head / admin, with E-382: may mark a query verified. */
  canVerify?: boolean;
  /** The agent could not be reached or did not answer in time. */
  unreachable: boolean;
  /** Set when the page could not load the agent's data, to say why. */
  problem: string | null;
  /** CEO / admin: may add, change and remove data sources. */
  canManage?: boolean;
  /** ID 167: this server's iTarang database login is the masked analyst_ro. */
  crmMasked?: boolean;
  /** CEO / admin: link to the answer-feedback review queue (E-380). */
  canReview?: boolean;
};

export function AnalystWorkspace({
  basePath,
  threadId,
  connections: initialConnections,
  history,
  threads: initialThreads,
  starters,
  current = null,
  threadsEnabled = false,
  verifiedEnabled = false,
  canVerify = false,
  dailyEnabled = false,
  unreachable,
  problem,
  canManage = false,
  crmMasked = false,
  canReview = false,
}: AnalystWorkspaceProps) {
  const router = useRouter();
  const { state, turns, ask, cancel } = useRun();
  const { viewportRef, contentRef, onSubmit: followSubmittedQuestion } = useTranscriptScroll();
  const [question, setQuestion] = useState("");
  const [threads, setThreads] = useState(initialThreads);
  const [connections, setConnections] = useState(initialConnections);
  const [panel, setPanel] = useState<PanelView | null>(null);
  // A continued thread keeps asking the source it was asking, if that still exists.
  // A35: otherwise the iTarang CRM database is selected by default.
  const [connectionId, setConnectionId] = useState(() => {
    const last = history[history.length - 1]?.connection_id;
    if (connections.some((c) => c.id === last)) return last;
    const crm = connections.find((c) => c.name === CRM_SOURCE_NAME);
    return crm?.id ?? connections[0]?.id ?? "";
  });

  const busy = isRunning(state.phase);
  const started = state.phase !== "idle";
  const shown = new Set([...turns.map((t) => t.runId), state.runId]);
  const past = history.filter((run) => !shown.has(run.id));
  const empty = !started && turns.length === 0 && past.length === 0;
  const active = connections.find((c) => c.id === connectionId) ?? null;
  // The agent refuses a source whose tables were listed but none chosen — unless the source
  // lets every table answer, when the agent finds the ones each question needs itself.
  const needsTables =
    active !== null && active.table_scope !== "all" && active.total_tables > 0 && active.selected_tables === 0;
  const ready = connectionId !== "" && !needsTables && !unreachable;
  const canSend = question.trim().length >= 3 && question.trim().length <= ANALYST_QUESTION_MAX && ready && !busy;

  const refreshConnections = useCallback(async () => {
    try {
      const next = await sourcesApi.list();
      setConnections(next);
      // Keep asking the chosen source; fall back to the first if it was removed, or to a
      // newly added one if there was none.
      setConnectionId((current) => (next.some((c) => c.id === current) ? current : (next[0]?.id ?? "")));
      return next;
    } catch {
      // The list on screen stays; the next action or page load corrects it.
    }
  }, []);

  // A Google dataset reads its files in the background; follow it until it settles.
  const syncing = connections.some((c) => c.sync_status === "syncing");
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(() => void refreshConnections(), 4000);
    return () => clearInterval(timer);
  }, [syncing, refreshConnections]);

  const refreshThreads = useCallback(async () => {
    try {
      const response = await fetch("/api/analyst/threads", { cache: "no-store" });
      if (response.ok) setThreads((await response.json()) as ListThread[]);
    } catch {
      // The optimistic row stays; the next page load corrects it.
    }
  }, []);

  // ── The conversation list (E-381): every change on screen first, put back if it fails ──
  const patchThread = useCallback(
    async (id: string, change: Partial<Pick<ListThread, "title" | "pinned" | "archived" | "shared">>, body: unknown) => {
      let before: ListThread[] = [];
      setThreads((list) => {
        before = list;
        return list.map((t) => (t.thread_id === id ? { ...t, ...change } : t));
      });
      try {
        const response = await fetch(`/api/analyst/threads/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error("failed");
        return true;
      } catch {
        setThreads(before);
        return false;
      }
    },
    [],
  );

  const threadActions: ThreadActions = {
    rename: (id, title) => {
      const clean = title.replace(/\s+/g, " ").trim();
      if (clean) void patchThread(id, { title: clean, title_custom: true } as Partial<ListThread>, { title: clean });
    },
    pin: (id, pinned) => void patchThread(id, { pinned }, { pinned }),
    archive: (id, archived) => void patchThread(id, { archived }, { archived }),
    remove: (id) => {
      let before: ListThread[] = [];
      setThreads((list) => {
        before = list;
        return list.filter((t) => t.thread_id !== id);
      });
      void fetch(`/api/analyst/threads/${encodeURIComponent(id)}`, { method: "DELETE" })
        .then((response) => {
          if (!response.ok) throw new Error("failed");
          // The open conversation was deleted: start a new one.
          if (id === threadId) router.push(basePath);
        })
        .catch(() => setThreads(before));
    },
  };

  const listed = threads.find((t) => t.thread_id === threadId) ?? null;
  const asked = started || turns.length > 0 || history.length > 0;
  const title = listed?.title ?? current?.title ?? (asked ? (history[0]?.question ?? turns[0]?.question ?? state.question) : null);
  const shared = listed?.shared ?? current?.shared ?? false;

  async function renameCurrent(next: string): Promise<boolean> {
    if (!threadsEnabled) return false;
    return patchThread(threadId, { title: next, title_custom: true } as Partial<ListThread>, { title: next });
  }

  function setShared(value: boolean) {
    setThreads((list) => list.map((t) => (t.thread_id === threadId ? { ...t, shared: value } : t)));
  }

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
  // Item 7 (edit a question) and item 6 (follow-ups) both ask in this conversation.
  // Sent straight away, leaving anything half-typed in the composer where it is.
  const askNow =
    ready && !busy
      ? (text: string) => {
          const asked = text.trim();
          if (asked.length >= 3 && asked.length <= ANALYST_QUESTION_MAX) void send(asked);
        }
      : null;

  return (
    <FeedbackProvider threadId={threadId}>
    <VerifiedProvider enabled={verifiedEnabled} canVerify={canVerify}>
    <DailyProvider enabled={dailyEnabled}>
    <div className="flex h-[calc(100dvh-10rem)] min-h-[32rem] min-w-0 overflow-hidden rounded-xl border border-border bg-surface shadow-card">
      <ThreadColumn
        basePath={basePath}
        threads={threads}
        activeId={threadId}
        enabled={threadsEnabled}
        actions={threadActions}
        className="hidden lg:flex"
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-3 sm:px-4">
          <ConversationTitle
            key={threadId}
            title={title}
            canRename={threadsEnabled && Boolean(listed ?? current)}
            onRename={renameCurrent}
          />
          <div className="flex shrink-0 items-center gap-1">
            <DailyMenu />
            {asked && !unreachable && !problem ? (
              <ShareMenu threadId={threadId} shared={shared} canShare={threadsEnabled} onShared={setShared} />
            ) : null}
            {unreachable ? null : (
              <ConnectionPicker connections={connections} value={connectionId} onChange={setConnectionId} active={active} />
            )}
            {unreachable || problem ? null : (
              <button
                type="button"
                onClick={() => setPanel({ view: "list" })}
                title="Data sources"
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem] font-medium text-ink-muted transition-colors hover:bg-bg hover:text-ink"
              >
                <Settings2 aria-hidden className="size-4" />
                <span className="hidden xl:inline">Data sources</span>
              </button>
            )}
            {verifiedEnabled && canReview ? (
              <Link
                href="/ceo/analyst/verified"
                title="Verified queries"
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem] font-medium text-ink-muted transition-colors hover:bg-bg hover:text-ink"
              >
                <BadgeCheck aria-hidden className="size-4" />
                <span className="hidden xl:inline">Verified</span>
              </Link>
            ) : null}
            {canReview ? (
              <Link
                href="/ceo/analyst/feedback"
                title="Answer feedback to review"
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem] font-medium text-ink-muted transition-colors hover:bg-bg hover:text-ink"
              >
                <MessageSquareWarning aria-hidden className="size-4" />
                <span className="hidden xl:inline">Feedback</span>
              </Link>
            ) : null}
            <MobileThreads
              basePath={basePath}
              threads={threads}
              activeId={threadId}
              enabled={threadsEnabled}
              actions={threadActions}
            />
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
                canManage={canManage}
                onAddSource={() => setPanel({ view: "add" })}
                onPick={ready && !busy ? (s) => submit(s) : null}
                starters={starters}
              />
            ) : (
              <div className="flex flex-col gap-10 pt-6 pb-12">
                {past.map((run, i) => (
                  <PastTurn
                    key={run.id}
                    run={run}
                    latest={!started && turns.length === 0 && i === past.length - 1}
                    onAskAgain={askAgain?.(run.question)}
                    onEdit={askNow}
                    onFollowUp={askNow}
                    limit={ANALYST_QUESTION_MAX}
                  />
                ))}
                {turns.map((turn, i) => (
                  <Turn
                    key={(turn.runId ?? "turn") + "-" + i}
                    turn={turn}
                    threadId={threadId}
                    latest={!started && i === turns.length - 1}
                    onAskAgain={turn.question ? askAgain?.(turn.question) : undefined}
                    onAsk={askNow}
                  />
                ))}
                {started ? (
                  <Turn
                    turn={state}
                    threadId={threadId}
                    live
                    latest
                    onAskAgain={state.question ? askAgain?.(state.question) : undefined}
                    onAsk={askNow}
                  />
                ) : null}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 px-3 pt-2 pb-3 sm:px-6">
          <div className="mx-auto w-full max-w-3xl">
            {needsTables && active ? (
              <p className="mb-2 text-center text-[0.8125rem] text-warning">
                No tables are chosen for {active.name} yet.{" "}
                {canManage ? (
                  <button
                    type="button"
                    onClick={() => setPanel({ view: "tables", connectionId: active.id })}
                    className="font-medium underline underline-offset-2 hover:text-ink"
                  >
                    Choose tables
                  </button>
                ) : (
                  "Ask the CEO, Sales Head or an admin to choose them."
                )}
              </p>
            ) : null}
            <Composer
              value={question}
              onChange={setQuestion}
              onSubmit={() => submit()}
              onStop={cancel}
              busy={busy}
              canSend={canSend}
              limit={ANALYST_QUESTION_MAX}
              disabled={!ready && !busy}
              placeholder={
                unreachable
                  ? "Waiting for the analyst service"
                  : connections.length === 0
                    ? "No data source is connected yet"
                    : needsTables
                      ? "Choose which tables the analyst may read first"
                      : empty
                        ? active?.table_scope === "all"
                          ? "Ask anything about your business data"
                          : "Ask anything about your data"
                        : "Ask a follow-up"
              }
            />
          </div>
        </div>

        {/* Balances the space above the welcome, which is what centres the composer. */}
        {empty ? <div aria-hidden className="flex-1" /> : null}
      </div>

      {panel ? (
        <SourcesPanel
          key={JSON.stringify(panel)}
          initialView={panel}
          connections={connections}
          canManage={canManage}
          crmMasked={crmMasked}
          onClose={() => setPanel(null)}
          onChanged={refreshConnections}
        />
      ) : null}
    </div>
    </DailyProvider>
    </VerifiedProvider>
    </FeedbackProvider>
  );
}

/** One question and everything the agent handed back for it. */
function Turn({
  turn,
  threadId,
  live,
  latest,
  onAskAgain,
  onAsk,
}: {
  turn: RunState;
  threadId: string;
  live?: boolean;
  latest: boolean;
  onAskAgain?: () => void;
  /** Ask another question in this conversation: an edited one, or a follow-up. */
  onAsk?: ((question: string) => void) | null;
}) {
  const running = isRunning(turn.phase);
  const finished = turn.phase === "done";
  const verified = useVerifiedMark(turn.runId, finished);
  // Ask before laying out: a chart that cannot be drawn honestly renders nothing, and the
  // table should not leave a gap where it was going to be.
  const plottable = turn.chart !== null && turn.result !== null && buildChart(turn.chart, turn.result).kind !== "none";
  const forecast = turn.chart ? forecastTable(turn.chart) : null;

  return (
    <div className="flex flex-col gap-5">
      <UserMessage at={turn.startedAt} text={turn.question} onEdit={running ? null : onAsk} limit={ANALYST_QUESTION_MAX}>
        {turn.question}
      </UserMessage>
      <AssistantMessage>
        {running ? <RunStatus state={turn} /> : null}
        {turn.answer ? <LiveAnswer text={turn.answer} live={Boolean(live)} /> : null}
        {plottable && turn.chart && turn.result ? <ResultChart spec={turn.chart} result={turn.result} /> : null}
        {forecast ? <ResultTable result={forecast} /> : null}
        {turn.result ? (
          <ResultTable result={turn.result} download={{ threadId, runId: turn.runId, question: turn.question ?? "" }} />
        ) : null}
        {turn.error ? <RunErrorPanel error={turn.error} /> : null}
        {turn.phase === "cancelled" ? <p className="text-[0.875rem] text-ink-muted">You stopped this run.</p> : null}
        {running ? null : (
          <MessageActions
            copyText={turn.answer}
            onAskAgain={onAskAgain}
            persistent={latest}
            runId={turn.runId}
            at={turn.startedAt !== null && turn.durationMs !== null ? turn.startedAt + turn.durationMs : null}
            hasSql={finished && Boolean(turn.sql?.trim())}
            verified={verified}
            question={turn.question}
          >
            <RunProcess state={turn} />
          </MessageActions>
        )}
        {finished ? <FollowUps question={turn.question} columns={turn.result?.columns} onAsk={onAsk} /> : null}
      </AssistantMessage>
    </div>
  );
}

/** Below lg the column is hidden; a History button opens it as a drawer. */
function MobileThreads(props: {
  basePath: string;
  threads: ListThread[];
  activeId: string;
  enabled: boolean;
  actions: ThreadActions;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Your conversations"
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem] font-medium text-ink-muted transition-colors hover:bg-bg hover:text-ink lg:hidden"
      >
        <History aria-hidden className="size-4" />
        <span className="sr-only">Your conversations</span>
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true" aria-label="Your conversations">
          <ThreadColumn {...props} className="flex h-full bg-surface shadow-card" />
          <button type="button" aria-label="Close" className="flex-1 bg-black/30" onClick={() => setOpen(false)} />
        </div>
      ) : null}
    </>
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
      {active?.kind === "file" ? (
        <FileSpreadsheet aria-hidden className="size-4 shrink-0 text-ink-muted" strokeWidth={1.75} />
      ) : (
        <Database aria-hidden className="size-4 shrink-0 text-ink-muted" strokeWidth={1.75} />
      )}
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
              <option key={c.id} value={c.id} disabled={c.sync_status === "syncing" && c.total_tables === 0}>
                {c.name}
                {c.kind === "file" ? " (files)" : ""}
                {c.sync_status === "syncing" ? " (reading files)" : ""}
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
  canManage,
  onAddSource,
  onPick,
  starters,
}: {
  connections: Connection[];
  active: Connection | null;
  unreachable: boolean;
  problem: string | null;
  canManage: boolean;
  onAddSource: () => void;
  onPick: ((question: string) => void) | null;
  starters: Starter[];
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
          <h2 className="text-xl font-semibold text-ink">The analyst service is not reachable</h2>
          <p className="mt-2 max-w-[46ch] text-[0.9375rem] leading-relaxed text-ink-muted">
            It did not answer just now. Try again in a moment.
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
          {canManage ? (
            <>
              <p className="mt-2 max-w-[52ch] text-[0.9375rem] leading-relaxed text-ink-muted">
                Connect the iTarang database, upload CSV, Excel or PDF files, or link a
                Google Sheet. Then ask questions about it in plain English.
              </p>
              <button
                type="button"
                onClick={onAddSource}
                className="mt-5 inline-flex items-center gap-2 rounded-full bg-brand-500 px-4 py-2 text-[0.875rem] font-medium text-white transition-colors hover:bg-brand-600"
              >
                <Plus aria-hidden className="size-4" /> Add a data source
              </button>
            </>
          ) : (
            <p className="mt-2 max-w-[52ch] text-[0.9375rem] leading-relaxed text-ink-muted">
              The CEO, Sales Head or an admin needs to connect a data source before questions can be asked.
            </p>
          )}
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
            {starters.map((s) => (
              <button
                key={s.question}
                type="button"
                disabled={!onPick}
                onClick={() => onPick?.(s.question)}
                className="rounded-xl border border-border bg-surface px-3.5 py-2.5 text-left text-[0.8125rem] text-ink transition-colors hover:border-brand-300 hover:bg-brand-50 disabled:opacity-50"
              >
                {s.personal ? (
                  <span className="mb-0.5 block text-[0.6875rem] font-medium text-brand-600">You often ask</span>
                ) : null}
                {s.question}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
