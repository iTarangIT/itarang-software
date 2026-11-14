"use client";

// AI Analyst — the caller's conversations (E-381): search, pinned first, Active / Archived, and
// a menu on each row to rename, pin, archive or delete. Titles wrap onto two lines; the full
// title shows on hover. Every change is made on screen first and put back if it fails.

import { Archive, ArchiveRestore, MessageSquarePlus, MoreHorizontal, Pencil, Pin, PinOff, Search, Share2, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { viewThreads, type ListThread, type ThreadView } from "@/lib/analyst/threadList";
import { formatWhenShort } from "@/lib/analyst/when";
import { cn } from "@/lib/utils";

export type ThreadActions = {
  rename: (threadId: string, title: string) => void;
  pin: (threadId: string, pinned: boolean) => void;
  archive: (threadId: string, archived: boolean) => void;
  remove: (threadId: string) => void;
};

export function ThreadColumn({
  basePath,
  threads,
  activeId,
  enabled,
  actions,
  className,
}: {
  basePath: string;
  threads: ListThread[];
  activeId: string;
  /** E-381 is applied: the row menu and the Archived view exist. */
  enabled: boolean;
  actions: ThreadActions;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [chosenView, setView] = useState<ThreadView>("active");
  const archivedCount = useMemo(() => threads.filter((t) => t.archived).length, [threads]);
  // An Archived view that has emptied goes back to the active list.
  const view: ThreadView = chosenView === "archived" && archivedCount === 0 ? "active" : chosenView;
  const shown = useMemo(() => viewThreads(threads, view, query), [threads, view, query]);
  const pinned = shown.filter((t) => t.pinned);
  const rest = shown.filter((t) => !t.pinned);

  return (
    <aside className={cn("w-64 shrink-0 flex-col border-r border-border bg-bg/60", className)}>
      <div className="flex flex-col gap-2 p-3">
        <Link
          href={basePath}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-3 py-2 text-[0.8125rem] font-medium text-white transition-colors hover:bg-brand-600"
        >
          <MessageSquarePlus aria-hidden className="size-4" />
          New conversation
        </Link>
        <label className="relative block">
          <span className="sr-only">Search your conversations</span>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-muted" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations"
            className="w-full rounded-lg border border-border bg-surface py-1.5 pr-7 pl-8 text-[0.8125rem] text-ink placeholder:text-ink-muted focus:border-brand-300 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-ink-muted hover:text-ink"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          ) : null}
        </label>
      </div>

      <div className="flex items-center justify-between px-4 pt-1 pb-2">
        <p className="text-[0.6875rem] font-semibold tracking-wide text-ink-muted uppercase">
          {view === "archived" ? "Archived" : "Your conversations"}
        </p>
        {enabled && (archivedCount > 0 || view === "archived") ? (
          <button
            type="button"
            onClick={() => setView(view === "archived" ? "active" : "archived")}
            className="text-[0.6875rem] font-medium text-brand-600 hover:underline"
          >
            {view === "archived" ? "Back" : `Archived (${archivedCount})`}
          </button>
        ) : null}
      </div>

      <nav aria-label="Your conversations" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {shown.length === 0 ? (
          <p className="px-2 py-2 text-[0.8125rem] text-ink-muted">
            {query
              ? "No conversation matches that search."
              : view === "archived"
                ? "Nothing archived."
                : "Nothing yet. Ask your first question."}
          </p>
        ) : (
          <>
            {pinned.length ? (
              <>
                <p className="px-2 pt-1 pb-1 text-[0.6875rem] font-medium text-ink-muted">Pinned</p>
                <ThreadList threads={pinned} basePath={basePath} activeId={activeId} enabled={enabled} actions={actions} />
                {rest.length ? <p className="px-2 pt-3 pb-1 text-[0.6875rem] font-medium text-ink-muted">Recent</p> : null}
              </>
            ) : null}
            <ThreadList threads={rest} basePath={basePath} activeId={activeId} enabled={enabled} actions={actions} />
          </>
        )}
      </nav>
    </aside>
  );
}

function ThreadList(props: {
  threads: ListThread[];
  basePath: string;
  activeId: string;
  enabled: boolean;
  actions: ThreadActions;
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {props.threads.map((thread) => (
        <ThreadRow key={thread.thread_id} thread={thread} {...props} />
      ))}
    </ul>
  );
}

function ThreadRow({
  thread,
  basePath,
  activeId,
  enabled,
  actions,
}: {
  thread: ListThread;
  basePath: string;
  activeId: string;
  enabled: boolean;
  actions: ThreadActions;
}) {
  const active = thread.thread_id === activeId;
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  const root = useRef<HTMLLIElement>(null);

  // Close the menu on a click elsewhere or Escape.
  useEffect(() => {
    if (!menu && !confirming) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setMenu(false);
        setConfirming(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(false);
        setConfirming(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, confirming]);

  if (renaming) {
    return (
      <li ref={root}>
        <form
          className="px-1 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            setRenaming(false);
            if (draft.trim() !== thread.title) actions.rename(thread.thread_id, draft);
          }}
        >
          <input
            autoFocus
            value={draft}
            maxLength={120}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => setRenaming(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setRenaming(false);
            }}
            aria-label="Conversation name"
            className="w-full rounded-lg border border-brand-300 bg-surface px-2 py-1.5 text-[0.8125rem] text-ink ring-2 ring-brand-100 focus:outline-none"
          />
        </form>
      </li>
    );
  }

  return (
    <li ref={root} className="group/row relative">
      <Link
        href={`${basePath}?thread=${encodeURIComponent(thread.thread_id)}`}
        title={thread.title}
        aria-current={active ? "page" : undefined}
        className={cn(
          "block rounded-lg py-2 pr-8 pl-2.5 text-[0.8125rem] transition-colors",
          active ? "bg-brand-50 font-medium text-brand-800" : "text-ink hover:bg-surface",
        )}
      >
        <span className="line-clamp-2 break-words">
          {thread.pinned ? <Pin aria-label="Pinned" className="mr-1 inline size-3 -translate-y-px text-ink-muted" /> : null}
          {thread.shared ? <Share2 aria-label="Shared" className="mr-1 inline size-3 -translate-y-px text-ink-muted" /> : null}
          {thread.title}
        </span>
        {thread.last_run_at ? (
          <time dateTime={thread.last_run_at} className="block truncate text-[0.6875rem] font-normal text-ink-muted">
            {formatWhenShort(thread.last_run_at)}
          </time>
        ) : null}
      </Link>

      {enabled ? (
        <button
          type="button"
          aria-label={`Options for ${thread.title}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => {
            setMenu((v) => !v);
            setConfirming(false);
          }}
          className={cn(
            "absolute top-1.5 right-1 flex size-7 items-center justify-center rounded-md text-ink-muted transition-opacity hover:bg-bg hover:text-ink",
            menu ? "opacity-100" : "opacity-100 md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100",
          )}
        >
          <MoreHorizontal aria-hidden className="size-4" />
        </button>
      ) : null}

      {menu ? (
        <div
          role="menu"
          className="absolute top-9 right-1 z-20 w-44 rounded-lg border border-border bg-surface p-1 shadow-card"
        >
          <MenuItem
            icon={<Pencil className="size-3.5" />}
            onClick={() => {
              setMenu(false);
              setDraft(thread.title);
              setRenaming(true);
            }}
          >
            Rename
          </MenuItem>
          <MenuItem
            icon={thread.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            onClick={() => {
              setMenu(false);
              actions.pin(thread.thread_id, !thread.pinned);
            }}
          >
            {thread.pinned ? "Unpin" : "Pin to top"}
          </MenuItem>
          <MenuItem
            icon={thread.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
            onClick={() => {
              setMenu(false);
              actions.archive(thread.thread_id, !thread.archived);
            }}
          >
            {thread.archived ? "Unarchive" : "Archive"}
          </MenuItem>
          <MenuItem
            icon={<Trash2 className="size-3.5" />}
            danger
            onClick={() => {
              setMenu(false);
              setConfirming(true);
            }}
          >
            Delete
          </MenuItem>
        </div>
      ) : null}

      {confirming ? (
        <div
          role="alertdialog"
          aria-label="Delete this conversation?"
          className="absolute top-9 right-1 z-20 w-56 rounded-lg border border-border bg-surface p-3 shadow-card"
        >
          <p className="text-[0.8125rem] text-ink">Delete this conversation?</p>
          <p className="mt-1 text-[0.75rem] text-ink-muted">It leaves your list. To keep it out of the way instead, archive it.</p>
          <div className="mt-2.5 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md px-2.5 py-1 text-[0.8125rem] text-ink-muted hover:bg-bg hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              autoFocus
              onClick={() => {
                setConfirming(false);
                actions.remove(thread.thread_id);
              }}
              className="rounded-md bg-danger px-2.5 py-1 text-[0.8125rem] font-medium text-white hover:opacity-90"
            >
              Delete
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function MenuItem({
  icon,
  danger,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem] transition-colors hover:bg-bg",
        danger ? "text-danger" : "text-ink",
      )}
    >
      <span aria-hidden className="flex">
        {icon}
      </span>
      {children}
    </button>
  );
}
