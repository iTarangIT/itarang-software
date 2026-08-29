"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface ProposedFix {
  file: string;
  search: string;
  replace: string;
  explanation: string;
}
interface ChatMessage {
  id?: string;
  role: string;
  message: string;
  proposedFix?: ProposedFix | null;
}

/**
 * AI resolution chat shown inside FindingDrawer. The human discusses the
 * finding with an agent that has read the affected source; when a fix is
 * proposed, "Resolve & Apply Fix" writes it to disk and marks the finding
 * resolved. If already resolved, renders the stored report + chat read-only.
 */
export default function ResolutionChat({
  findingId,
  status,
  resolutionReport,
}: {
  findingId: string;
  status: string;
  resolutionReport: Record<string, unknown> | null;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualDiff, setManualDiff] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const resolved = status === "resolved";

  useEffect(() => {
    let alive = true;
    fetch(`/api/it/security/findings/${findingId}/chat`)
      .then((r) => r.json())
      .then((d) => {
        if (alive && d.ok) setMessages(d.messages ?? []);
      })
      .catch(() => {})
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [findingId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, applying]);

  const latestFix = [...messages].reverse().find((m) => m.role === "assistant" && m.proposedFix)?.proposedFix ?? null;

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setError(null);
    setManualDiff(null);
    setInput("");
    setMessages((m) => [...m, { role: "user", message: text }]);
    setSending(true);
    try {
      const res = await fetch(`/api/it/security/findings/${findingId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const d = await res.json();
      if (d.ok) {
        setMessages((m) => [...m, { role: "assistant", message: d.reply, proposedFix: d.proposedFix }]);
      } else {
        setError(d.error || "The assistant could not respond.");
      }
    } catch {
      setError("Network error — try again.");
    } finally {
      setSending(false);
    }
  };

  const applyFix = async () => {
    if (applying) return;
    setError(null);
    setManualDiff(null);
    setApplying(true);
    try {
      const res = await fetch(`/api/it/security/findings/${findingId}/resolve`, { method: "POST" });
      const d = await res.json();
      if (d.ok && d.applied) {
        router.refresh();
        return;
      }
      // Not applied (disabled / prod / drifted) — surface the reason + any diff.
      setError(d.error || "Could not apply the fix.");
      if (d.diff) setManualDiff(d.diff);
    } catch {
      setError("Network error while applying the fix.");
    } finally {
      setApplying(false);
    }
  };

  // ---- Resolved: read-only report ----
  if (resolved && resolutionReport) {
    const rep = resolutionReport as Record<string, string | boolean>;
    return (
      <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 p-4">
        <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-semibold text-sm">
          <span className="h-2 w-2 rounded-full bg-emerald-500" /> Problem Resolved
        </div>
        {rep.explanation ? (
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">{String(rep.explanation)}</p>
        ) : null}
        <dl className="mt-3 text-xs text-slate-600 dark:text-slate-400 space-y-1">
          {rep.file ? (
            <div>
              <span className="text-slate-400">File:</span> <code>{String(rep.file)}</code>
            </div>
          ) : null}
          {rep.applied_by ? (
            <div>
              <span className="text-slate-400">By:</span> {String(rep.applied_by)}
            </div>
          ) : null}
          {rep.applied_at || rep.resolved_at ? (
            <div>
              <span className="text-slate-400">When:</span>{" "}
              {new Date(String(rep.applied_at ?? rep.resolved_at)).toLocaleString()}
            </div>
          ) : null}
          {rep.resolved_from_ip ? (
            <div>
              <span className="text-slate-400">From IP:</span>{" "}
              <code className="font-mono">{String(rep.resolved_from_ip)}</code>
            </div>
          ) : null}
        </dl>
        <a
          href="/it/security/history"
          className="mt-3 inline-block text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:underline"
        >
          View full resolution history →
        </a>
        {rep.diff ? <DiffBlock diff={String(rep.diff)} /> : null}
        {messages.length > 0 ? (
          <details className="mt-3">
            <summary className="text-xs text-slate-500 cursor-pointer">View resolution conversation</summary>
            <div className="mt-2 space-y-2">
              {messages.map((m, i) => (
                <Bubble key={i} role={m.role} text={m.message} />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    );
  }

  // ---- Active: interactive chat ----
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800">
      <div ref={scrollRef} className="max-h-80 overflow-y-auto p-3 space-y-2">
        {!loaded ? (
          <p className="text-xs text-slate-400">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-xs text-slate-400">
            Ask the AI how to fix this finding — it has read the affected source file. When you agree on a fix,
            hit <b>Resolve &amp; Apply Fix</b> and it will patch the code and mark this resolved.
          </p>
        ) : (
          messages.map((m, i) => <Bubble key={i} role={m.role} text={m.message} />)
        )}
        {sending ? <p className="text-xs text-slate-400">Thinking…</p> : null}
      </div>

      {latestFix ? (
        <div className="border-t border-slate-200 dark:border-slate-800 p-3 bg-slate-50 dark:bg-slate-900/50">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
            Proposed fix{latestFix.file ? ` · ${latestFix.file}` : ""}
          </div>
          {latestFix.explanation ? (
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{latestFix.explanation}</p>
          ) : null}
          <DiffBlock diff={`- ${latestFix.search.split("\n").join("\n- ")}\n+ ${latestFix.replace.split("\n").join("\n+ ")}`} />
          <button
            type="button"
            onClick={applyFix}
            disabled={applying}
            className="mt-2 w-full px-3 py-2 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
          >
            {applying ? "Applying…" : "Resolve & Apply Fix"}
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="border-t border-amber-200 dark:border-amber-900 p-3 bg-amber-50 dark:bg-amber-950/30">
          <p className="text-xs text-amber-700 dark:text-amber-400">{error}</p>
          {manualDiff ? <DiffBlock diff={manualDiff} /> : null}
        </div>
      ) : null}

      <div className="border-t border-slate-200 dark:border-slate-800 p-2 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
          placeholder="How do I fix this? / Propose the fix…"
          disabled={sending}
          className="flex-1 text-sm px-3 py-2 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={send}
          disabled={sending || !input.trim()}
          className="px-3 py-2 text-sm font-medium rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function Bubble({ role, text }: { role: string; text: string }) {
  if (role === "system") {
    return <p className="text-[11px] italic text-slate-400 text-center">{text}</p>;
  }
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
          isUser
            ? "bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900"
            : "bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200"
        }`}
      >
        {text}
      </div>
    </div>
  );
}

function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="mt-2 text-[11px] leading-relaxed rounded p-2 bg-slate-900 text-slate-100 overflow-x-auto max-h-56 overflow-y-auto">
      {diff.split("\n").map((line, i) => {
        const color = line.startsWith("+")
          ? "text-emerald-400"
          : line.startsWith("-")
            ? "text-red-400"
            : "text-slate-400";
        return (
          <div key={i} className={color}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
