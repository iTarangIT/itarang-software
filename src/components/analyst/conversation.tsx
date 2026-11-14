"use client";

// AI Analyst — the open conversation's title in the header (item 5: rename it in place) and its
// Share / Export menu (item 13: a read-only link for other analyst users, Markdown download,
// print or save as PDF).

import { Check, Copy, Download, Link2, Link2Off, Pencil, Printer, Share2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export function ConversationTitle({
  title,
  canRename,
  onRename,
}: {
  /** null = a new conversation with nothing asked yet. */
  title: string | null;
  canRename: boolean;
  onRename: (title: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title ?? "");
  const [failed, setFailed] = useState(false);

  async function save() {
    setEditing(false);
    const next = draft.replace(/\s+/g, " ").trim();
    if (!title || next === title) return;
    setFailed(!(await onRename(next)));
  }

  if (editing && title) {
    return (
      <form
        className="flex min-w-0 flex-1 items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Sparkles aria-hidden className="size-4 shrink-0 text-brand-500" />
        <input
          autoFocus
          value={draft}
          maxLength={120}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(title);
              setEditing(false);
            }
          }}
          aria-label="Conversation name"
          placeholder="Name this conversation"
          className="min-w-0 flex-1 rounded-lg border border-brand-300 bg-surface px-2 py-1 text-[0.9375rem] font-semibold text-ink ring-2 ring-brand-100 focus:outline-none"
        />
      </form>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Sparkles aria-hidden className="size-4 shrink-0 text-brand-500" />
      <h1 className="truncate text-[0.9375rem] font-semibold text-ink" title={title ?? undefined}>
        {title ?? "AI Analyst"}
      </h1>
      {title && canRename ? (
        <button
          type="button"
          onClick={() => {
            setDraft(title);
            setFailed(false);
            setEditing(true);
          }}
          aria-label="Rename conversation"
          title="Rename conversation"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-bg hover:text-ink"
        >
          <Pencil aria-hidden className="size-3.5" strokeWidth={1.75} />
        </button>
      ) : null}
      {failed ? <span className="shrink-0 text-[0.75rem] text-danger">Could not rename.</span> : null}
      {!title ? (
        <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[0.6875rem] font-medium text-brand-700">Beta</span>
      ) : null}
    </div>
  );
}

export function ShareMenu({
  threadId,
  shared,
  canShare,
  onShared,
}: {
  threadId: string;
  shared: boolean;
  /** E-381 is applied, so a share link can be made. */
  canShare: boolean;
  onShared: (shared: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const id = encodeURIComponent(threadId);

  async function copyLink() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/analyst/threads/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "share" }),
      });
      const body = (await response.json().catch(() => ({}))) as { path?: string; error?: string };
      if (!response.ok || !body.path) throw new Error(body.error ?? "could not make a link");
      const url = new URL(body.path, window.location.origin).toString();
      onShared(true);
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
        setMessage("Link copied. The CEO, Sales Head and admin can open it, read-only.");
      } catch {
        setMessage(url);
      }
    } catch (error) {
      setMessage(error instanceof Error ? `Could not share: ${error.message}` : "Could not share.");
    } finally {
      setBusy(false);
    }
  }

  async function stopSharing() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/analyst/threads/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "unshare" }),
      });
      if (!response.ok) throw new Error("failed");
      onShared(false);
      setMessage("Sharing stopped. The old link no longer works.");
    } catch {
      setMessage("Could not stop sharing.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setMessage(null);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Share or export this conversation"
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem] font-medium text-ink-muted transition-colors hover:bg-bg hover:text-ink"
      >
        <Share2 aria-hidden className="size-4" />
        <span className="hidden sm:inline">Share</span>
      </button>
      {open ? (
        <div role="menu" className="absolute top-10 right-0 z-30 w-64 rounded-lg border border-border bg-surface p-1 shadow-card">
          {canShare ? (
            <>
              <Item
                icon={copied ? <Check className="size-3.5 text-success" /> : shared ? <Copy className="size-3.5" /> : <Link2 className="size-3.5" />}
                onClick={() => void copyLink()}
                disabled={busy}
              >
                {shared ? "Copy share link" : "Share a read-only link"}
              </Item>
              {shared ? (
                <Item icon={<Link2Off className="size-3.5" />} onClick={() => void stopSharing()} disabled={busy}>
                  Stop sharing
                </Item>
              ) : null}
              <div className="my-1 h-px bg-border" />
            </>
          ) : null}
          <a
            role="menuitem"
            href={`/api/analyst/threads/${id}/export`}
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem] text-ink transition-colors hover:bg-bg"
          >
            <Download aria-hidden className="size-3.5" />
            Download (Markdown)
          </a>
          <a
            role="menuitem"
            href={`/analyst/print?thread=${id}`}
            target="_blank"
            rel="noopener"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem] text-ink transition-colors hover:bg-bg"
          >
            <Printer aria-hidden className="size-3.5" />
            Print or save as PDF
          </a>
          {message ? <p className="px-2 pt-1.5 pb-1 text-[0.75rem] break-all text-ink-muted">{message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function Item({
  icon,
  onClick,
  disabled,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem] text-ink transition-colors hover:bg-bg",
        "disabled:opacity-50",
      )}
    >
      <span aria-hidden className="flex">
        {icon}
      </span>
      {children}
    </button>
  );
}
