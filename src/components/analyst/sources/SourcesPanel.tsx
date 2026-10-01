"use client";

// Data Analyst — the "Data sources" drawer: what the analyst can read, and (for the CEO or an
// admin) adding, changing and removing it. Sources are shared by every CRM analyst user — the
// agent has one tenant — so a sales head sees this list read-only.

import { ArrowLeft, Database, FileSpreadsheet, Loader2, Plus, RefreshCw, Table2, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { Connection, SourceList } from "@/lib/analyst/types";
import { Tabs } from "@/components/ui/tabs";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

import { formatBytes, sourcesApi } from "./api";
import { FileDrop, FileKindIcon, usePickedFiles } from "./FileDrop";
import { Field, GoogleSourceFlow, INPUT } from "./GoogleSourceFlow";
import { TablePicker } from "./TablePicker";

export type PanelView =
  | { view: "list" }
  | { view: "add" }
  | { view: "tables"; connectionId: string }
  | { view: "files"; connectionId: string };

/** Mounted only while open; the caller keys it on the view it opens with. */
export function SourcesPanel({
  initialView,
  connections,
  canManage,
  onClose,
  onChanged,
}: {
  initialView: PanelView;
  connections: Connection[];
  canManage: boolean;
  onClose: () => void;
  /** Re-read the connection list; returns the fresh list. */
  onChanged: () => Promise<Connection[] | void>;
}) {
  const [view, setView] = useState<PanelView>(initialView);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const current =
    view.view === "tables" || view.view === "files" ? connections.find((c) => c.id === view.connectionId) : null;
  const title =
    view.view === "add"
      ? "Add a data source"
      : view.view === "tables"
        ? `Tables · ${current?.name ?? ""}`
        : view.view === "files"
          ? `Files · ${current?.name ?? ""}`
          : "Data sources";

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-ink/30" />
      <aside
        role="dialog"
        aria-label={title}
        className="relative flex h-full w-full max-w-xl flex-col bg-surface shadow-2xl"
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
          {view.view !== "list" ? (
            <button
              type="button"
              onClick={() => setView({ view: "list" })}
              aria-label="Back to data sources"
              className="rounded-lg p-1.5 text-ink-muted hover:bg-bg hover:text-ink"
            >
              <ArrowLeft aria-hidden className="size-4" />
            </button>
          ) : null}
          <h2 className="min-w-0 flex-1 truncate text-[0.9375rem] font-semibold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink-muted hover:bg-bg hover:text-ink"
          >
            <X aria-hidden className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {view.view === "list" ? (
            <SourceListView connections={connections} canManage={canManage} setView={setView} onChanged={onChanged} />
          ) : view.view === "add" && canManage ? (
            <AddSource
              onCreated={async (connection, next) => {
                await onChanged();
                setView(next === "tables" ? { view: "tables", connectionId: connection } : { view: "list" });
              }}
            />
          ) : view.view === "tables" ? (
            <TablePicker connectionId={view.connectionId} canManage={canManage} onSaved={() => void onChanged()} />
          ) : view.view === "files" && current ? (
            <DatasetFiles connection={current} canManage={canManage} onChanged={onChanged} />
          ) : null}
        </div>
      </aside>
    </div>
  );
}

// ── List ─────────────────────────────────────────────────────────────────────

function SourceListView({
  connections,
  canManage,
  setView,
  onChanged,
}: {
  connections: Connection[];
  canManage: boolean;
  setView: (v: PanelView) => void;
  onChanged: () => Promise<Connection[] | void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function remove(c: Connection) {
    const ok = await confirmDialog({
      title: `Remove ${c.name}?`,
      message:
        c.kind === "file"
          ? "Its files are deleted from the analyst. Past conversations stay, but can't be continued on it."
          : "The analyst forgets this database's address. Nothing in the database itself changes.",
      confirmText: "Remove",
      variant: "danger",
    });
    if (!ok) return;
    setBusy(c.id);
    try {
      await sourcesApi.remove(c.id);
      toast.success(`Removed ${c.name}`);
      await onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {canManage ? (
        <button
          type="button"
          onClick={() => setView({ view: "add" })}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-[0.8125rem] font-medium text-white hover:bg-brand-600"
        >
          <Plus aria-hidden className="size-4" /> Add a data source
        </button>
      ) : (
        <p className="text-[0.8125rem] text-ink-muted">
          Data sources are managed by the CEO or an admin. You can ask questions on any of them.
        </p>
      )}

      {connections.length === 0 ? (
        <p className="py-6 text-center text-[0.875rem] text-ink-muted">No data source is connected yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {connections.map((c) => (
            <li key={c.id} className="rounded-xl border border-border p-3">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50">
                  {c.kind === "file" ? (
                    <FileSpreadsheet aria-hidden className="size-4 text-brand-500" />
                  ) : (
                    <Database aria-hidden className="size-4 text-brand-500" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.875rem] font-medium text-ink">{c.name}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[0.75rem] text-ink-muted">
                    <span>{c.kind === "file" ? `Dataset · ${c.file_count} file${c.file_count === 1 ? "" : "s"}` : "Database"}</span>
                    <span>
                      {c.selected_tables} of {c.total_tables} tables chosen
                    </span>
                    <SyncBadge status={c.sync_status} />
                  </p>
                  {c.total_tables > 0 && c.selected_tables === 0 ? (
                    <p className="mt-1 text-[0.75rem] text-warning">Choose tables before asking on this source.</p>
                  ) : null}
                </div>
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <SmallButton onClick={() => setView({ view: "tables", connectionId: c.id })}>
                  <Table2 aria-hidden className="size-3.5" /> {canManage ? "Choose tables" : "Tables"}
                </SmallButton>
                {c.kind === "file" ? (
                  <SmallButton onClick={() => setView({ view: "files", connectionId: c.id })}>
                    <FileSpreadsheet aria-hidden className="size-3.5" /> Files
                  </SmallButton>
                ) : null}
                {canManage ? (
                  <SmallButton onClick={() => void remove(c)} disabled={busy === c.id} danger>
                    {busy === c.id ? (
                      <Loader2 aria-hidden className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 aria-hidden className="size-3.5" />
                    )}
                    Remove
                  </SmallButton>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SyncBadge({ status }: { status: Connection["sync_status"] }) {
  if (!status) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.6875rem] font-medium",
        status === "syncing" && "bg-brand-50 text-brand-700",
        status === "ready" && "bg-success-bg text-success",
        status === "failed" && "bg-danger-bg text-danger",
      )}
    >
      {status === "syncing" ? <Loader2 aria-hidden className="size-3 animate-spin" /> : null}
      {status === "syncing" ? "Reading files" : status === "ready" ? "Up to date" : "Sync failed"}
    </span>
  );
}

function SmallButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[0.75rem] font-medium transition-colors disabled:opacity-60",
        danger ? "text-danger hover:bg-danger-bg" : "text-ink hover:bg-bg",
      )}
    >
      {children}
    </button>
  );
}

// ── Add ──────────────────────────────────────────────────────────────────────

const ADD_TABS = [
  { value: "crm", label: "iTarang database" },
  { value: "postgres", label: "Other database" },
  { value: "files", label: "Files" },
  { value: "google", label: "Google Sheets / Drive" },
];

function AddSource({ onCreated }: { onCreated: (connectionId: string, next: "tables" | "list") => Promise<void> }) {
  const [tab, setTab] = useState("crm");
  // A Google dataset is created before its link is checked; if the flow is abandoned the agent
  // keeps an empty dataset, so it is removed here on the way out.
  const orphan = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (orphan.current) void sourcesApi.remove(orphan.current).catch(() => {});
    },
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      <Tabs tabs={ADD_TABS} value={tab} onValueChange={setTab} className="overflow-x-auto" />
      {tab === "crm" ? <CrmDatabase onCreated={onCreated} /> : null}
      {tab === "postgres" ? <PostgresForm onCreated={onCreated} /> : null}
      {tab === "files" ? <FilesForm onCreated={onCreated} /> : null}
      {tab === "google" ? (
        <GoogleSourceFlow
          onDatasetCreated={(id) => (orphan.current = id)}
          onDone={(id) => {
            orphan.current = null;
            void onCreated(id, "tables");
          }}
        />
      ) : null}
    </div>
  );
}

function CrmDatabase({ onCreated }: { onCreated: (id: string, next: "tables") => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3 text-[0.8125rem] text-ink">
      <p className="leading-relaxed">
        Connect the CRM&rsquo;s own database — leads, dealers, AI calls, invoices, expenses and more — through a
        read-only login. The analyst can never change data, and personal documents (KYC, Aadhaar, PAN) are not
        readable through it.
      </p>
      <p className="text-ink-muted">Next you choose which tables (up to 12) the analyst may use.</p>
      {error ? <p className="text-danger">{error}</p> : null}
      <div>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const c = await sourcesApi.connectCrm();
              toast.success("Connected the iTarang database");
              await onCreated(c.id, "tables");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 font-medium text-white hover:bg-brand-600 disabled:opacity-60"
        >
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Database aria-hidden className="size-4" />}
          {busy ? "Connecting — this can take a minute" : "Connect iTarang database"}
        </button>
      </div>
    </div>
  );
}

function PostgresForm({ onCreated }: { onCreated: (id: string, next: "tables") => Promise<void> }) {
  const [name, setName] = useState("");
  const [dsn, setDsn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return setError("Name this database.");
        if (!/^postgres(ql)?(\+psycopg)?:\/\//.test(dsn.trim())) return setError("The address must start with postgresql://");
        setBusy(true);
        setError(null);
        try {
          const c = await sourcesApi.connectPostgres(name.trim(), dsn.trim());
          toast.success(`Connected ${c.name}`);
          await onCreated(c.id, "tables");
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className={INPUT} placeholder="e.g. Warehouse DB" />
      </Field>
      <Field label="Connection address" error={error}>
        <input
          value={dsn}
          onChange={(e) => setDsn(e.target.value)}
          type="password"
          autoComplete="off"
          className={cn(INPUT, "font-mono")}
          placeholder="postgresql://readonly_user:password@host:5432/dbname"
        />
      </Field>
      <p className="text-[0.75rem] text-ink-muted">
        Use a read-only login. Only the <code>public</code> schema is visible, and the database must accept connections
        from the analyst service. The address is stored encrypted by the analyst and never shown again.
      </p>
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-[0.8125rem] font-medium text-white hover:bg-brand-600 disabled:opacity-60"
        >
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
          Connect
        </button>
      </div>
    </form>
  );
}

function FilesForm({ onCreated }: { onCreated: (id: string, next: "tables") => Promise<void> }) {
  const picked = usePickedFiles();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const { files, problem } = picked.ready();
        if (!name.trim()) return setError("Name this dataset.");
        if (problem) return setError(problem);
        setBusy(true);
        setError(null);
        try {
          const c = await sourcesApi.uploadNew(files, name.trim());
          toast.success(`Uploaded ${files.length} file${files.length === 1 ? "" : "s"} to ${c.name}`);
          await onCreated(c.id, "tables");
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Dataset name">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className={INPUT} placeholder="e.g. Q3 dealer sales" />
      </Field>
      <FileDrop picked={picked} disabled={busy} />
      <p className="text-[0.75rem] text-ink-muted">
        Files in one dataset can be asked about together. A question asks one source at a time.
      </p>
      {error ? <p className="text-[0.8125rem] text-danger">{error}</p> : null}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-[0.8125rem] font-medium text-white hover:bg-brand-600 disabled:opacity-60"
        >
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
          {busy ? "Uploading and reading…" : "Upload"}
        </button>
      </div>
    </form>
  );
}

// ── A dataset's files ────────────────────────────────────────────────────────

function DatasetFiles({
  connection,
  canManage,
  onChanged,
}: {
  connection: Connection;
  canManage: boolean;
  onChanged: () => Promise<Connection[] | void>;
}) {
  const [list, setList] = useState<SourceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<"files" | "google" | null>(null);
  const picked = usePickedFiles();

  const load = async () => {
    try {
      setList(await sourcesApi.sources(connection.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id]);

  // Follow a running sync until it settles.
  useEffect(() => {
    if (list?.sync_status !== "syncing") return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list?.sync_status]);

  async function run(key: string, action: () => Promise<unknown>, done: string) {
    setBusy(key);
    try {
      await action();
      toast.success(done);
      await load();
      await onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p className="text-[0.875rem] text-danger">{error}</p>;
  if (!list) {
    return (
      <p className="flex items-center gap-2 text-[0.875rem] text-ink-muted">
        <Loader2 aria-hidden className="size-4 animate-spin" /> Loading files…
      </p>
    );
  }
  const hasGoogle = list.sources.some((s) => s.origin !== "upload");

  return (
    <div className="flex flex-col gap-4">
      {canManage ? (
        <div className="flex flex-wrap gap-1.5">
          <SmallButton onClick={() => setAdding(adding === "files" ? null : "files")}>
            <Plus aria-hidden className="size-3.5" /> Add files
          </SmallButton>
          <SmallButton onClick={() => setAdding(adding === "google" ? null : "google")}>
            <Plus aria-hidden className="size-3.5" /> Add Google source
          </SmallButton>
          {hasGoogle ? (
            <SmallButton
              disabled={busy === "sync" || list.sync_status === "syncing"}
              onClick={() => void run("sync", () => sourcesApi.sync(connection.id), "Sync started")}
            >
              <RefreshCw aria-hidden className={cn("size-3.5", list.sync_status === "syncing" && "animate-spin")} />
              Sync now
            </SmallButton>
          ) : null}
        </div>
      ) : null}

      {adding === "files" ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <FileDrop picked={picked} disabled={busy === "upload"} />
          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy === "upload"}
              onClick={() => {
                const { files, problem } = picked.ready();
                if (problem) return toast.error(problem);
                void run(
                  "upload",
                  async () => {
                    await sourcesApi.uploadMore(files, connection.id);
                    picked.clear();
                    setAdding(null);
                  },
                  `Added ${files.length} file${files.length === 1 ? "" : "s"}`,
                );
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-1.5 text-[0.8125rem] font-medium text-white hover:bg-brand-600 disabled:opacity-60"
            >
              {busy === "upload" ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
              Upload
            </button>
          </div>
        </div>
      ) : null}
      {adding === "google" ? (
        <div className="rounded-xl border border-border p-3">
          <GoogleSourceFlow
            existingConnectionId={connection.id}
            onDone={() => {
              setAdding(null);
              void load();
              void onChanged();
            }}
          />
        </div>
      ) : null}

      {list.sources.map((source) => (
        <section key={source.id} className="rounded-xl border border-border">
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <p className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-ink">{source.label}</p>
            {source.status === "pending" ? <span className="text-[0.6875rem] text-warning">not set up</span> : null}
            {canManage && source.origin !== "upload" ? (
              <button
                type="button"
                disabled={busy === source.id}
                onClick={() => void run(source.id, () => sourcesApi.removeSource(connection.id, source.id), `Removed ${source.label}`)}
                className="rounded p-1 text-ink-muted hover:bg-danger-bg hover:text-danger"
                aria-label={`Remove ${source.label}`}
              >
                <Trash2 aria-hidden className="size-3.5" />
              </button>
            ) : null}
          </header>
          <ul className="flex flex-col divide-y divide-border">
            {source.files.map((file) => (
              <li key={file.id} className="flex items-center gap-2 px-3 py-1.5 text-[0.75rem]">
                <FileKindIcon name={file.name} />
                <span className="min-w-0 flex-1 truncate text-ink" title={file.tables.join(", ")}>
                  {file.name}
                </span>
                <span
                  className={cn(
                    "shrink-0",
                    file.status === "ready" ? "text-ink-muted" : file.status === "failed" ? "text-danger" : "text-warning",
                  )}
                  title={file.reason ?? undefined}
                >
                  {file.status === "ready"
                    ? `${file.tables.length} table${file.tables.length === 1 ? "" : "s"} · ${formatBytes(file.bytes)}`
                    : (file.reason ?? file.status)}
                </span>
                {canManage && source.origin === "upload" ? (
                  <button
                    type="button"
                    disabled={busy === file.id}
                    onClick={() =>
                      void run(file.id, () => sourcesApi.removeFile(connection.id, file.name), `Removed ${file.name}`)
                    }
                    className="rounded p-0.5 text-ink-muted hover:bg-danger-bg hover:text-danger"
                    aria-label={`Remove ${file.name}`}
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
            {source.files.length === 0 ? (
              <li className="px-3 py-2 text-[0.75rem] text-ink-muted">No files read yet.</li>
            ) : null}
          </ul>
        </section>
      ))}
    </div>
  );
}
