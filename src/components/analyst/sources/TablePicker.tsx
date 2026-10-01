"use client";

// Data Analyst — choosing which tables of a source the analyst may read. The agent refuses to
// answer on a source whose tables were listed but none chosen, and caps the choice (12 by
// default) so the model's prompt stays small enough to write good SQL.

import { ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import type { TableList } from "@/lib/analyst/types";
import { cn } from "@/lib/utils";

import { sourcesApi } from "./api";

export function TablePicker({
  connectionId,
  canManage,
  onSaved,
}: {
  connectionId: string;
  canManage: boolean;
  onSaved: () => void;
}) {
  const [list, setList] = useState<TableList | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "refresh" | null>(null);

  function take(next: TableList) {
    setList(next);
    setChosen(new Set(next.tables.filter((t) => t.selected).map((t) => t.name)));
  }

  useEffect(() => {
    let live = true;
    sourcesApi
      .tables(connectionId)
      .then((next) => live && take(next))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [connectionId]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (list?.tables ?? []).filter((t) => !q || t.name.toLowerCase().includes(q));
  }, [list, filter]);

  if (error) return <p className="text-[0.875rem] text-danger">{error}</p>;
  if (!list) {
    return (
      <p className="flex items-center gap-2 text-[0.875rem] text-ink-muted">
        <Loader2 aria-hidden className="size-4 animate-spin" /> Loading tables…
      </p>
    );
  }

  const max = list.max_selected;
  const full = chosen.size >= max;

  function toggle(name: string) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else if (next.size < max) next.add(name);
      return next;
    });
  }

  async function refresh() {
    setBusy("refresh");
    try {
      const next = await sourcesApi.refreshTables(connectionId);
      take(next);
      const added = next.added?.length ?? 0;
      const removed = next.removed?.length ?? 0;
      toast.success(added || removed ? `Tables refreshed: ${added} new, ${removed} gone` : "Tables are up to date");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    try {
      take(await sourcesApi.saveTables(connectionId, [...chosen]));
      toast.success(`The analyst can now read ${chosen.size} table${chosen.size === 1 ? "" : "s"}`);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${list.tables.length} tables`}
          className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-[0.8125rem] text-ink outline-none focus:ring-2 focus:ring-brand-100"
        />
        {canManage ? (
          <button
            type="button"
            onClick={refresh}
            disabled={busy !== null}
            title="Look for new or removed tables"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[0.8125rem] text-ink-muted hover:bg-bg disabled:opacity-60"
          >
            <RefreshCw aria-hidden className={cn("size-3.5", busy === "refresh" && "animate-spin")} />
            Refresh
          </button>
        ) : null}
      </div>

      <p className={cn("text-[0.75rem]", full ? "text-warning" : "text-ink-muted")}>
        {chosen.size} of at most {max} chosen{full ? " — untick one to choose another" : ""}. Pick only what the
        questions need; fewer tables give better SQL.
      </p>

      {list.tables.length === 0 ? (
        <p className="text-[0.875rem] text-ink-muted">This source has no tables the analyst can read yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {shown.map((t) => {
            const on = chosen.has(t.name);
            const columns = t.definition?.columns ?? [];
            return (
              <li key={t.name}>
                <div className="flex items-center gap-2 px-2.5 py-2">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!canManage || (!on && full)}
                    onChange={() => toggle(t.name)}
                    aria-label={`Let the analyst read ${t.name}`}
                    className="size-4 accent-brand-500"
                  />
                  <button
                    type="button"
                    onClick={() => setOpen(open === t.name ? null : t.name)}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left"
                  >
                    <ChevronRight
                      aria-hidden
                      className={cn("size-3.5 shrink-0 text-ink-muted transition-transform", open === t.name && "rotate-90")}
                    />
                    <span className="truncate font-mono text-[0.8125rem] text-ink">{t.name}</span>
                    <span className="ml-auto shrink-0 text-[0.6875rem] text-ink-muted">
                      {columns.length ? `${columns.length} columns` : ""}
                    </span>
                  </button>
                </div>
                {open === t.name ? (
                  <div className="border-t border-border bg-bg px-8 py-2 text-[0.75rem]">
                    {t.definition?.comment ? <p className="mb-1 text-ink-muted">{t.definition.comment}</p> : null}
                    {t.files.length ? <p className="mb-1 text-ink-muted">From {t.files.join(", ")}</p> : null}
                    <ul className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                      {columns.map((c) => (
                        <li key={c.name} className="flex min-w-0 gap-2">
                          <span className="truncate font-mono text-ink">{c.name}</span>
                          <span className="shrink-0 text-ink-muted">{c.type.toLowerCase()}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canManage ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={busy !== null || chosen.size === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-[0.8125rem] font-medium text-white hover:bg-brand-600 disabled:opacity-60"
          >
            {busy === "save" ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
            Save tables
          </button>
        </div>
      ) : null}
    </div>
  );
}
