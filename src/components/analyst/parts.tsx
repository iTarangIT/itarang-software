"use client";

// Data Analyst — the pieces of a conversation. Ported from the agent's own frontend
// (components/ask/*) and restyled onto the CRM's tokens in globals.css. The agent's WebGL orb,
// shimmer text and Streamdown/shiki/katex renderer were left behind: react-markdown + GFM
// covers what an analytics answer uses (paragraphs, lists, tables, bold, inline code).

import { AlertTriangle, ArrowUp, Check, ChevronDown, ChevronRight, Copy, RotateCcw } from "lucide-react";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { columnIsNumeric, renderCell } from "@/lib/analyst/cells";
import {
  answeringAttempt,
  buildProcessSteps,
  confirmedRejections,
  liveTool,
  plainSummary,
  processSummary,
  REFUSAL_LABEL,
  rowCount,
  stageLabel,
  toolLabel,
  type PlainSummary,
  type ProcessStep,
} from "@/lib/analyst/run-process";
import {
  isRunning,
  type Cell,
  type ResultTable as Result,
  type RunError,
  type RunState,
} from "@/lib/analyst/run-types";
import type { Attempt, RunDetail, RunSummary } from "@/lib/analyst/types";
import { cn } from "@/lib/utils";

import { useTypedAnswer } from "./hooks";

// ── Messages ──────────────────────────────────────────────────────────────────

export function UserMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-3xl bg-bg px-4 py-2.5 text-[0.9375rem] leading-relaxed break-words whitespace-pre-wrap text-ink sm:max-w-[75%]">
        {children}
      </div>
    </div>
  );
}

/** No bubble: the reply uses the column's full width, because tables and charts need it. */
export function AssistantMessage({ children }: { children: React.ReactNode }) {
  // `min-w-0` down the chain, or a 50-column result stretches the transcript.
  return <div className="group flex min-w-0 flex-col gap-4">{children}</div>;
}

const ANSWER_CLASS = cn(
  "min-w-0 text-[0.9375rem] leading-7 text-ink",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_p]:my-3 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_li]:my-1",
  "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold",
  "[&_h2]:mt-6 [&_h2]:mb-2.5 [&_h2]:text-lg [&_h2]:font-semibold",
  "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:font-semibold [&_strong]:font-semibold",
  "[&_hr]:my-6 [&_hr]:border-border",
  "[&_blockquote]:border-l-4 [&_blockquote]:border-brand-200 [&_blockquote]:pl-3 [&_blockquote]:text-ink-muted",
  "[&_:not(pre)>code]:rounded-md [&_:not(pre)>code]:bg-bg [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.875em]",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-brand-navy [&_pre]:p-3.5 [&_pre]:font-mono [&_pre]:text-[0.8125rem] [&_pre]:text-white/90",
  "[&_a]:text-brand-600 [&_a]:underline [&_a]:underline-offset-4",
  "[&_table]:my-3 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-[0.8125rem]",
  "[&_th]:border [&_th]:border-border [&_th]:bg-bg [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium",
  "[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5",
);

/**
 * The answer. `shown` is the typed-out part and `full` the whole of it; while they differ the
 * visible copy is hidden from screen readers, which read the complete answer instead.
 */
export function AnswerText({ shown, full }: { shown: string; full: string }) {
  const typing = shown !== full;
  return (
    <>
      <div aria-hidden={typing || undefined} className={ANSWER_CLASS}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{shown}</ReactMarkdown>
      </div>
      {typing ? <p className="sr-only">{full}</p> : null}
    </>
  );
}

/** Copy, ask again, and the run's details. Results are never stored — asking again refreshes them. */
export function MessageActions({
  copyText,
  onAskAgain,
  persistent,
  children,
}: {
  copyText?: string | null;
  onAskAgain?: () => void;
  persistent: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "-mt-1 -ml-2 flex flex-wrap items-center gap-0.5",
        !persistent &&
          "transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 md:has-[[aria-expanded=true]]:opacity-100",
      )}
    >
      {copyText ? <CopyButton text={copyText} /> : null}
      <ActionButton
        label="Ask again"
        title="Results are not stored. Ask again for fresh numbers."
        onClick={onAskAgain}
        disabled={!onAskAgain}
      >
        <RotateCcw className="size-4" strokeWidth={1.75} />
      </ActionButton>
      {children}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused; the answer is selectable.
    }
  }
  return (
    <ActionButton label={copied ? "Copied" : "Copy answer"} onClick={copy}>
      {copied ? <Check className="size-4 text-success" strokeWidth={2} /> : <Copy className="size-4" strokeWidth={1.75} />}
    </ActionButton>
  );
}

function ActionButton({
  label,
  title,
  onClick,
  disabled,
  children,
}: {
  label: string;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
      className="flex size-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-bg hover:text-ink disabled:pointer-events-none disabled:opacity-40"
    >
      <span aria-hidden className="flex">
        {children}
      </span>
    </button>
  );
}

// ── Composer ──────────────────────────────────────────────────────────────────

const COMPOSER_MAX_HEIGHT = 208;

/** Enter sends, Shift+Enter breaks the line; ignored mid-IME composition. */
export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  canSend,
  disabled = false,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
  canSend: boolean;
  disabled?: boolean;
  placeholder: string;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [value]);

  function send() {
    if (busy || !canSend) return;
    onSubmit();
  }

  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        className={cn(
          "flex items-end gap-2 rounded-[1.75rem] border border-border bg-surface py-2 pr-2 pl-5 shadow-card transition-colors",
          "focus-within:border-brand-300 focus-within:ring-2 focus-within:ring-brand-100",
          disabled && "bg-bg",
        )}
      >
        <textarea
          ref={textarea}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
          }}
          rows={1}
          disabled={disabled}
          aria-label="Your question"
          placeholder={placeholder}
          className="max-h-52 min-h-9 flex-1 resize-none self-center border-0 bg-transparent py-1.5 text-[0.9375rem] leading-6 text-ink placeholder:text-ink-muted/70 focus-visible:outline-none disabled:cursor-not-allowed"
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            title="Stop"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white transition-colors hover:bg-brand-600"
          >
            <span aria-hidden className="size-3 rounded-[3px] bg-current" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send"
            title="Send"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white transition-colors hover:bg-brand-600 disabled:opacity-40 disabled:hover:bg-brand-500"
          >
            <ArrowUp aria-hidden className="size-[1.125rem]" strokeWidth={2.25} />
          </button>
        )}
      </form>
      <p className="px-2 pt-2 text-center text-xs text-ink-muted/80">
        Read-only. The analyst never writes to the database. Check important numbers before acting on them.
      </p>
    </div>
  );
}

// ── Live status ───────────────────────────────────────────────────────────────

/** The real stage from the stream, never rotating filler: a stall should look like one. */
export function RunStatus({ state }: { state: RunState }) {
  const [now, setNow] = useState(() => Date.now());
  const live = isRunning(state.phase);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [live, state.startedAt]);
  if (!live) return null;

  const seconds = Math.max(0, Math.floor((now - (state.startedAt ?? now)) / 1000));
  const label =
    state.phase === "connecting" ? "Sending your question" : stageLabel(state.stage ?? "router", state.attempts.at(-1)?.tool);
  const text = `${label}…${confirmedRejections(state.attempts) > 0 ? ` · attempt ${state.attempts.length}` : ""}`;

  return (
    <div className="flex min-w-0 items-center gap-2.5 text-[0.9375rem]">
      <span aria-hidden className="size-2.5 shrink-0 animate-pulse rounded-full bg-brand-500" />
      <span role="status" className="min-w-0 truncate text-ink-muted">
        {text}
      </span>
      <span className="shrink-0 font-mono text-xs text-ink-muted/70" aria-label={`${seconds} seconds elapsed`}>
        ({seconds}s)
      </span>
    </div>
  );
}

// ── Errors ────────────────────────────────────────────────────────────────────

function recovery(error: RunError): string | null {
  switch (error.code) {
    case "not_found":
      return "That data source is gone. Pick another one.";
    case "budget_exhausted":
      return "The analyst's daily budget is spent. It refills over the next 24 hours.";
    case "rate_limited":
      return "Too many questions at once. Wait a moment and ask again.";
    case "unauthorized":
      return "Your session ended. Sign in again.";
    case "not_configured":
      return "The analyst is not set up on this server yet. Ask IT to check the ANALYST_* settings.";
    case "upstream":
      return "The analyst service may be waking up (up to a minute). Try again shortly.";
    default:
      break;
  }
  if (error.kind === "truncated") return "The run may still have finished. Reopen this conversation before asking again.";
  if (error.kind === "transport") return "Check your connection and ask again.";
  return null;
}

export function RunErrorPanel({ error }: { error: RunError }) {
  const next = recovery(error);
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-bg px-4 py-3.5">
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={2} />
      <div className="min-w-0">
        <p className="text-[0.875rem] font-medium text-danger">{error.message}</p>
        {next ? <p className="mt-1 text-[0.875rem] text-ink-muted">{next}</p> : null}
      </div>
    </div>
  );
}

// ── Result table ──────────────────────────────────────────────────────────────

/**
 * The result grid. Hand-built because the agent sends Decimal/date/UUID cells as STRINGS
 * ("266300.00"); nothing here ever calls Number() on a cell, so a figure is printed exactly as
 * the database expressed it.
 */
export function ResultTable({ result }: { result: Result }) {
  const { columns, rows, truncated } = result;
  const numeric = columns.map((_, i) => columnIsNumeric(rows, i));

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-card">
      <div className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-2.5">
        <p className="text-xs font-medium text-ink-muted">{rowCount(rows.length)}</p>
        {truncated ? <p className="text-xs text-warning">Capped. Ask for a narrower range to see the rest.</p> : null}
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-[0.875rem] text-ink-muted">The query ran and matched nothing.</p>
      ) : (
        <div className="max-h-[26rem] overflow-auto">
          <table className="w-full border-collapse font-mono text-[0.8125rem]">
            <thead>
              <tr>
                {columns.map((column, i) => (
                  <th
                    key={`${column}-${i}`}
                    scope="col"
                    className={cn(
                      "sticky top-0 z-10 border-b border-border bg-bg px-4 py-2 font-medium whitespace-nowrap text-ink-muted",
                      numeric[i] ? "text-right" : "text-left",
                    )}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r} className="border-b border-border last:border-b-0">
                  {row.map((value, c) => (
                    <td
                      key={c}
                      className={cn("px-4 py-1.5 whitespace-nowrap text-ink", numeric[c] ? "text-right tabular-nums" : "text-left")}
                    >
                      <RenderedCell value={value} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RenderedCell({ value }: { value: Cell }) {
  const rendered = renderCell(value);
  if (rendered.kind === "value" || rendered.kind === "json") return rendered.text;
  return <span className="text-ink-muted">{rendered.kind === "null" ? "null" : rendered.text}</span>;
}

// ── How it was answered ───────────────────────────────────────────────────────

function SqlBlock({ sql, label = "Query" }: { sql: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // selectable anyway
    }
  }
  return (
    <div className="group/sql relative overflow-hidden rounded-lg bg-brand-navy text-white/90">
      <p className="px-4 pt-3 text-[0.625rem] font-semibold tracking-[0.08em] text-white/45 uppercase">{label}</p>
      <pre className="overflow-x-auto px-4 pt-2 pb-3.5 font-mono text-[0.8125rem] leading-[1.7] whitespace-pre-wrap">
        <code>{sql}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "SQL copied" : "Copy SQL"}
        className="absolute top-2.5 right-2.5 rounded-md p-1.5 text-white/50 opacity-0 transition-opacity group-hover/sql:opacity-100 hover:text-white focus-visible:opacity-100"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

function RunTimeline({ steps }: { steps: ProcessStep[] }) {
  if (!steps.length) return null;
  return (
    <ol aria-label="Run steps" className="flex flex-col">
      {steps.map((step, index) => (
        <li key={index} className="relative flex items-start gap-3 py-1">
          {index < steps.length - 1 ? (
            <span aria-hidden className="absolute top-[1.375rem] left-[0.4375rem] h-[calc(100%-1.25rem)] w-px bg-border" />
          ) : null}
          <span
            aria-hidden
            className={cn(
              "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
              step.mark === "done" ? "bg-brand-500" : "border border-brand-silver bg-surface",
            )}
          >
            {step.mark === "done" ? <Check className="size-2.5 text-white" strokeWidth={3.5} /> : null}
          </span>
          <span className="min-w-0 text-[0.8125rem] leading-5">
            <span className={step.mark === "done" ? "text-ink" : "text-ink-muted"}>{step.label}</span>
            {step.note ? <span className="text-ink-muted"> · {step.note}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

type ProcessProps = { state: RunState; detail?: never } | { detail: RunDetail; state?: never };

/** The disclosure under every answer: steps, the SQL that ran, and a plain-English summary. */
export function RunProcess({ state, detail }: ProcessProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const phase = state?.phase ?? detail!.status;
  const duration = state ? (state.durationMs ?? 0) : detail!.duration_ms;
  const trace = state ? { stages: state.stageLog, attempts: state.attempts } : detail!.trace;
  const attempts = trace?.attempts ?? [];
  const summary = processSummary(phase, duration, trace ? attempts.length : undefined, confirmedRejections(attempts));
  const steps = trace ? buildProcessSteps(trace.stages, attempts, phase) : [];
  const simple = trace ? plainSummary(attempts, phase) : null;
  const tool = toolLabel(state ? liveTool(state) : detail!.tool);
  const rows = state ? state.result?.rows.length : detail!.rows_returned;
  const truncated = state ? state.result?.truncated : answeringAttempt(attempts)?.truncated;
  const accepted = attempts.filter((a) => a.sql && !a.rejected);
  const refused = attempts.filter((a) => a.sql && a.rejected);
  const sql = state?.sql ?? detail?.sql;

  // `contents`: the toggle joins the action row beside Copy / Ask again, and the panel wraps
  // onto a full-width line of its own.
  return (
    <div className="contents">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 max-w-full items-center gap-1.5 rounded-lg px-2 text-left text-[0.8125rem] text-ink-muted transition-colors hover:bg-bg hover:text-ink"
      >
        {phase === "done" ? <Check aria-hidden className="size-3.5 shrink-0 text-success" /> : null}
        <span>{summary}</span>
        <ChevronDown aria-hidden className={cn("size-3.5 shrink-0", open && "rotate-180")} />
      </button>
      {open ? (
        <section
          id={id}
          aria-label="How this was answered"
          className="mt-2 flex min-w-0 basis-full flex-col gap-4 rounded-xl border border-border bg-surface p-4"
        >
          <h3 className="text-xs font-semibold text-ink">How this was answered</h3>
          <RunTimeline steps={steps} />
          {accepted.length ? (
            accepted.map((a, i) => (
              <SqlBlock key={i} sql={a.sql!} label={accepted.length > 1 ? `Query ${i + 1}` : "Query"} />
            ))
          ) : sql ? (
            <SqlBlock sql={sql} />
          ) : (
            <p className="text-xs text-ink-muted">No SQL was recorded.</p>
          )}
          {refused.length ? <RefusedQueries attempts={refused} /> : null}
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <Fact term="Tool">
              <span className="font-mono">{tool ?? "None recorded"}</span>
            </Fact>
            <Fact term="Rows">
              {rows === undefined ? "Not available" : rowCount(rows)}
              {truncated === true ? " · cut off" : truncated === false ? " · complete" : ""}
            </Fact>
            <Fact term="Time">{(duration / 1000).toFixed(1)}s</Fact>
            {detail ? (
              <Fact term="Tokens">
                {detail.prompt_tokens} prompt · {detail.completion_tokens} completion
              </Fact>
            ) : null}
            {detail?.model ? (
              <Fact term="Model">
                <span className="font-mono">{detail.model}</span>
              </Fact>
            ) : null}
          </dl>
          {simple ? <InSimpleTerms summary={simple} /> : null}
        </section>
      ) : null}
    </div>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="text-ink-muted">{term}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

function RefusedQueries({ attempts }: { attempts: Attempt[] }) {
  return (
    <details className="group/refused">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md text-xs text-ink-muted transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3.5 shrink-0 group-open/refused:rotate-90" strokeWidth={2} />
        {attempts.length} rejected {attempts.length === 1 ? "query" : "queries"}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {attempts.map((a, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <SqlBlock sql={a.sql!} label={REFUSAL_LABEL[a.at ?? "guard"]} />
            {a.reason ? <p className="text-xs break-words text-ink-muted">Reason: {a.reason}</p> : null}
          </div>
        ))}
      </div>
    </details>
  );
}

function InSimpleTerms({ summary }: { summary: PlainSummary }) {
  const lines = (
    [
      ["What", summary.what],
      ["Why", summary.why],
      ["Means", summary.means],
    ] as const
  ).filter(([, text]) => text);
  return (
    <div className="rounded-lg bg-bg p-3">
      <h4 className="text-xs font-semibold text-ink">In simple terms</h4>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[0.8125rem] leading-5">
        {lines.map(([term, text]) => (
          <Fragment key={term}>
            <dt className="text-ink-muted">{term}</dt>
            <dd className="min-w-0 text-ink">{text}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

// ── A turn from an earlier sitting, replayed from the agent ───────────────────

/**
 * Reads like any other message but without a result table: the agent records how many rows
 * came back, never what they were. Each answer loads when its turn comes near the viewport.
 */
export function PastTurn({ run, latest, onAskAgain }: { run: RunSummary; latest: boolean; onAskAgain?: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const element = root.current;
    if (!element || near) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true);
    }, { rootMargin: "600px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);

  return (
    <div ref={root} className="flex flex-col gap-5">
      <UserMessage>{run.question}</UserMessage>
      <AssistantMessage>
        {near ? <Reply runId={run.id} latest={latest} onAskAgain={onAskAgain} /> : <ReplySkeleton />}
      </AssistantMessage>
    </div>
  );
}

function Reply({ runId, latest, onAskAgain }: { runId: string; latest: boolean; onAskAgain?: () => void }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/analyst/runs/${encodeURIComponent(runId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("failed");
        setDetail((await response.json()) as RunDetail);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not load that answer.");
      });
    return () => controller.abort();
  }, [runId]);

  if (error) return <p className="text-[0.875rem] text-danger">{error}</p>;
  if (!detail) return <ReplySkeleton />;

  return (
    <>
      {detail.answer ? <AnswerText shown={detail.answer} full={detail.answer} /> : null}
      {detail.error ? <RunErrorPanel error={{ kind: "agent", message: detail.error }} /> : null}
      {!detail.answer && !detail.error ? (
        <p className="text-[0.875rem] text-ink-muted">No answer was recorded for this run.</p>
      ) : null}
      <MessageActions copyText={detail.answer} onAskAgain={onAskAgain} persistent={latest}>
        <RunProcess detail={detail} />
      </MessageActions>
    </>
  );
}

function ReplySkeleton() {
  return (
    <div role="presentation" className="flex flex-col gap-2.5 pt-1.5 pb-8">
      <span className="h-3.5 w-11/12 animate-pulse rounded-full bg-bg" />
      <span className="h-3.5 w-3/4 animate-pulse rounded-full bg-bg" />
    </div>
  );
}

/** The typed-out answer of a live or this-sitting turn. */
export function LiveAnswer({ text, live }: { text: string; live: boolean }) {
  const shown = useTypedAnswer(text, live);
  return <AnswerText shown={shown} full={text} />;
}
