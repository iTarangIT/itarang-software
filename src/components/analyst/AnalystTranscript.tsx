import "server-only";

// AI Analyst — a conversation read back in full, read-only (E-381): the shared-link view and
// the print / "Save as PDF" view. Server-rendered, every answer and query included.

import { ArrowLeft, BadgeCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { TranscriptRun } from "@/lib/analyst/transcript";
import { formatWhen } from "@/lib/analyst/when";

import { PrintNow } from "./PrintNow";

const PRINT_CSS = `@media print {
  body * { visibility: hidden !important; }
  #analyst-print, #analyst-print * { visibility: visible !important; }
  #analyst-print { position: absolute; inset: 0 auto auto 0; width: 100%; max-width: none; padding: 0 12mm; }
  .analyst-no-print { display: none !important; }
  .analyst-turn { break-inside: avoid-page; }
}`;

const ANSWER_CLASS =
  "text-[0.9375rem] leading-7 text-ink [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_strong]:font-semibold [&_table]:my-3 [&_table]:text-[0.8125rem] [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5 [&_th]:border [&_th]:border-border [&_th]:bg-bg [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-6";

export function AnalystTranscript({
  title,
  subtitle,
  runs,
  backHref,
  print = false,
}: {
  title: string;
  subtitle: string;
  runs: TranscriptRun[];
  backHref: string;
  print?: boolean;
}) {
  return (
    <div id="analyst-print" className="mx-auto max-w-3xl space-y-8 pb-16">
      {/* Print only the transcript, not the dashboard around it. */}
      <style>{PRINT_CSS}</style>
      {print ? <PrintNow /> : null}

      <div className="space-y-2">
        <Link
          href={backHref}
          className="analyst-no-print inline-flex items-center gap-1 text-xs font-semibold text-brand-sky hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> AI Analyst
        </Link>
        <div className="flex items-start gap-2">
          <Sparkles aria-hidden className="mt-1.5 size-4 shrink-0 text-brand-500" />
          <h1 className="text-2xl font-bold tracking-tight break-words text-brand-navy">{title}</h1>
        </div>
        <p className="text-sm text-ink-muted">{subtitle}</p>
      </div>

      {runs.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface p-6 text-sm text-ink-muted">
          This conversation has no answers yet.
        </p>
      ) : (
        runs.map((run, i) => (
          <section key={run.id} className="analyst-turn space-y-3 border-t border-border pt-6">
            <div className="flex flex-col items-end gap-1">
              <div className="max-w-[85%] rounded-3xl bg-bg px-4 py-2.5 text-[0.9375rem] leading-relaxed break-words whitespace-pre-wrap text-ink">
                {run.question}
              </div>
              <time className="px-2 text-[0.6875rem] text-ink-muted">{formatWhen(run.created_at)}</time>
            </div>
            {run.verified ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-[0.75rem] font-medium text-success">
                <BadgeCheck aria-hidden className="size-3.5" /> Verified query
              </span>
            ) : null}
            {run.answer ? (
              <div className={ANSWER_CLASS}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{run.answer}</ReactMarkdown>
              </div>
            ) : run.error ? (
              <p className="text-sm text-danger">The analyst could not answer: {run.error}</p>
            ) : (
              <p className="text-sm text-ink-muted">No answer was recorded.</p>
            )}
            {run.sql ? (
              <details open={print}>
                <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink">Query {i + 1}</summary>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-brand-navy p-3.5 font-mono text-[0.8125rem] whitespace-pre-wrap text-white/90">
                  {run.sql}
                </pre>
              </details>
            ) : null}
          </section>
        ))
      )}
      <p className="border-t border-border pt-4 text-xs text-ink-muted">
        Result tables are not stored with a conversation. Ask again in the AI Analyst for fresh numbers.
      </p>
    </div>
  );
}
