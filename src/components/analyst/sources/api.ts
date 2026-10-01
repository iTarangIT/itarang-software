"use client";

// Data Analyst — the browser's calls for data sources. Everything goes through the CRM's own
// /api/analyst/connections proxy; the agent is never called from the browser.

import type {
  Connection,
  DriveListing,
  DryRun,
  ResolveResult,
  Source,
  SourceList,
  SourceRule,
  TableList,
} from "@/lib/analyst/types";

const BASE = "/api/analyst/connections";

export class SourceCallError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { cache: "no-store", ...init });
  } catch {
    throw new SourceCallError("could not reach the CRM — check your connection", 0);
  }
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new SourceCallError(body?.error ?? `request failed (${response.status})`, response.status);
  }
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const id = encodeURIComponent;

function filesForm(files: File[]): FormData {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  return form;
}

export const sourcesApi = {
  list: () => call<Connection[]>(""),
  connectCrm: () => call<Connection>("", json("POST", { preset: "crm" })),
  connectPostgres: (name: string, dsn: string) => call<Connection>("", json("POST", { name, dsn })),
  createDataset: (name: string) => call<Connection>("/dataset", json("POST", { name })),
  remove: (connectionId: string) => call<void>(`/${id(connectionId)}`, { method: "DELETE" }),

  /** A new dataset from uploaded files. */
  uploadNew: (files: File[], name: string) => {
    const form = filesForm(files);
    form.append("name", name);
    return call<Connection>("/file", { method: "POST", body: form });
  },
  /** More files into an existing dataset. */
  uploadMore: (files: File[], connectionId: string) =>
    call<TableList>(`/${id(connectionId)}/files`, { method: "POST", body: filesForm(files) }),
  removeFile: (connectionId: string, filename: string) =>
    call<TableList>(`/${id(connectionId)}/files/${id(filename)}`, { method: "DELETE" }),

  sources: (connectionId: string) => call<SourceList>(`/${id(connectionId)}/sources`),
  removeSource: (connectionId: string, sourceId: string) =>
    call<SourceList>(`/${id(connectionId)}/sources/${id(sourceId)}`, { method: "DELETE" }),
  sync: (connectionId: string) => call<{ status: "queued" }>(`/${id(connectionId)}/sync`, { method: "POST" }),

  resolveGoogle: (connectionId: string, url: string, confirmUnverified = false) =>
    call<ResolveResult>(
      `/${id(connectionId)}/google/resolve`,
      json("POST", { url, confirm_unverified: confirmUnverified }),
    ),
  driveTree: (connectionId: string, sourceId: string, folderId?: string) => {
    const query = new URLSearchParams({ source_id: sourceId });
    if (folderId) query.set("folder_id", folderId);
    return call<DriveListing>(`/${id(connectionId)}/google/tree?${query}`);
  },
  chooseSource: (connectionId: string, body: { source_id: string; rules: SourceRule[]; combine: boolean }) =>
    call<Source>(`/${id(connectionId)}/sources`, json("POST", { ...body, dry_run: false })),
  dryRun: (connectionId: string, body: { source_id: string; rules: SourceRule[]; combine: boolean }) =>
    call<DryRun>(`/${id(connectionId)}/sources`, json("POST", { ...body, dry_run: true })),

  tables: (connectionId: string) => call<TableList>(`/${id(connectionId)}/tables`),
  saveTables: (connectionId: string, tables: string[]) =>
    call<TableList>(`/${id(connectionId)}/tables`, json("PUT", { tables })),
  refreshTables: (connectionId: string) =>
    call<TableList>(`/${id(connectionId)}/tables/refresh`, { method: "POST" }),
};

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
