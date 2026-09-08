"use client";

/**
 * E-216 — Google Drive folder management + "Scan now".
 *
 * E-280 made this generic over WHICH side of the accounts folder is being read.
 * The same panel now drives two independent scanners: the purchase side into
 * expense_submissions, and the sale side into sales_invoices. They are separate
 * folder registrations with inverted include/exclude filters, so one component
 * with a config beats two 380-line copies that drift.
 *
 * Kept out of ExpenseTrackerView (already 736 lines) so the manual-upload flow
 * and the automated flow stay separately readable.
 *
 * Two things this UI is deliberate about:
 *  - It shows the last run's counters rather than a bare "done". A scan that
 *    saw 40 files and imported 0 is either "nothing new" or "everything is
 *    broken", and only the breakdown tells you which.
 *  - It surfaces the service-account email on failure, because the single most
 *    common cause of an empty scan is the folder never having been shared with
 *    it — which Drive reports as an empty folder, not as an error.
 */

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  readJsonBody,
  readJsonData,
  startScanAndWait,
  type ScanRunResult,
} from "@/lib/drive/scanClient";
import {
  AlertTriangle,
  Check,
  CloudOff,
  FolderPlus,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface DriveFolder {
  id: string;
  drive_folder_id: string;
  label: string | null;
  is_active: boolean;
  recursive: boolean;
  include_names: string;
  exclude_names: string;
  last_scanned_at: string | null;
}

/**
 * What the panel renders. The shared shape from scanClient, with the two
 * counters this panel always shows made non-optional so a tile cannot render
 * `undefined`.
 */
type ScanSummary = ScanRunResult & {
  folders_scanned: number;
  unsupported: number;
};

/**
 * What became of every file this folder has ever recorded — the lifetime view,
 * as opposed to a single run's counters. `retryable` is the number that makes
 * "0 new" actionable instead of a dead end.
 */
interface FolderCoverage {
  folder_id: string;
  total: number;
  imported: number;
  duplicate: number;
  needs_attention: number;
  unsupported: number;
  failed: number;
  expense_rows: number;
  retryable: number;
}

const inputCls =
  "w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-900 bg-white focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";

function tokenList(raw: string): string {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Everything that differs between the purchase and sale sides. The endpoints
 * and query keys are the load-bearing part; the copy matters because the
 * include-filter is the single setting that decides whether this imports
 * company spend or company revenue.
 */
export interface DriveFoldersPanelConfig {
  testId: string;
  title: string;
  description: string;
  foldersEndpoint: string;
  scanEndpoint: string;
  /**
   * Same route as scanEndpoint, GET ?run_id=, for a scan that starts in the
   * background and reports back later. Omitted by a scan that still answers
   * synchronously — then the POST's own reply is the result.
   */
  statusEndpoint?: string;
  /**
   * Lifetime per-folder status split. Omitted by a side that has no coverage
   * reader yet, in which case the panel simply does not render the line.
   */
  coverageEndpoint?: string;
  foldersQueryKey: string;
  /** Everything that reads the table this scanner writes. */
  invalidateKeys: string[][];
  scanLabel: string;
  emptyHint: string;
  removeTitle: string;
  includeHint: (tokens: string) => string;
  noFilterWarning: string;
}

export const EXPENSE_PANEL: DriveFoldersPanelConfig = {
  testId: "drive-folders-panel",
  title: "Google Drive folders — purchases",
  description:
    "Invoices and costing sheets dropped in these folders are imported as expenses every few hours.",
  foldersEndpoint: "/api/admin/ai-expenses/drive/folders",
  scanEndpoint: "/api/admin/ai-expenses/drive/scan",
  statusEndpoint: "/api/admin/ai-expenses/drive/scan",
  coverageEndpoint: "/api/admin/ai-expenses/drive/runs?view=coverage",
  foldersQueryKey: "drive-folders",
  invalidateKeys: [
    ["drive-folders"],
    ["drive-runs"],
    ["drive-attention"],
    ["drive-coverage"],
    ["ai-expenses"],
    ["ai-expense-tags"],
    ["dashboard-metrics", "ceo"],
    ["ceo-expenses-summary"],
    ["ceo-snapshot-summary"],
  ],
  scanLabel: "Scan now",
  emptyHint:
    "No folders yet. Share a Drive folder with the service account, then paste its link above.",
  removeTitle: "Remove folder (imported expenses are kept)",
  includeHint: (tokens) =>
    `Importing only what is inside folders named ${tokens}. The sale side is read separately into revenue, so it stays out of expenses.`,
  noFilterWarning:
    "No purchase filter set — every folder in this tree is imported, including customer invoices, which would book revenue as spend.",
};

export const SALES_PANEL: DriveFoldersPanelConfig = {
  testId: "sales-folders-panel",
  title: "Google Drive folders — sales invoices",
  description:
    "Since the move off Zoho to Vyapar, revenue is read from the sale side of these folders. Scanned every few hours.",
  foldersEndpoint: "/api/admin/sales-invoices/drive/folders",
  scanEndpoint: "/api/admin/sales-invoices/drive/scan",
  statusEndpoint: "/api/admin/sales-invoices/drive/scan",
  foldersQueryKey: "sales-folders",
  invalidateKeys: [
    ["sales-folders"],
    ["sales-runs"],
    ["ceo-invoices"],
    ["dashboard-metrics", "ceo"],
    ["ceo-snapshot-summary"],
  ],
  scanLabel: "Scan sales now",
  emptyHint:
    "No folders yet. Share the accounts folder with the service account, then paste its link above.",
  removeTitle: "Remove folder (imported invoices are kept)",
  includeHint: (tokens) =>
    `Importing only what is inside folders named ${tokens}. The purchase side is read separately into expenses, so it stays out of revenue.`,
  noFilterWarning:
    "No sale filter set — every folder in this tree is imported, including supplier bills, which would book spend as revenue.",
};

export function DriveFoldersPanel({
  config = EXPENSE_PANEL,
}: {
  config?: DriveFoldersPanelConfig;
} = {}) {
  const qc = useQueryClient();
  const [folderInput, setFolderInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ScanSummary | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: [config.foldersQueryKey],
    queryFn: async () => {
      const r = await fetch(config.foldersEndpoint, {
        cache: "no-store",
      });
      return readJsonData<{ folders: DriveFolder[]; drive_configured: boolean }>(
        r,
        "Failed to load",
      );
    },
  });

  const folders = data?.folders ?? [];
  const driveConfigured = data?.drive_configured ?? false;

  // The lifetime split behind "N unchanged, not re-read". Refetched after a
  // scan (via invalidateKeys) so the numbers move as files are recovered.
  const { data: coverage } = useQuery({
    queryKey: ["drive-coverage"],
    enabled: Boolean(config.coverageEndpoint),
    queryFn: async () => {
      const r = await fetch(config.coverageEndpoint as string, { cache: "no-store" });
      return readJsonData<{ coverage: FolderCoverage[] }>(r, "Failed to load");
    },
  });
  const coverageByFolder = new Map(
    (coverage?.coverage ?? []).map((c) => [c.folder_id, c]),
  );

  const addFolder = useMutation({
    mutationFn: async (folder: string) => {
      const r = await fetch(config.foldersEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder }),
      });
      await readJsonBody(r, "Could not add folder");
    },
    onSuccess: () => {
      setFolderInput("");
      setError(null);
      qc.invalidateQueries({ queryKey: [config.foldersQueryKey] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const toggleFolder = useMutation({
    mutationFn: async (vars: { id: string; is_active: boolean }) => {
      const r = await fetch(config.foldersEndpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(vars),
      });
      await readJsonBody(r, "Update failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [config.foldersQueryKey] }),
    onError: (e: Error) => setError(e.message),
  });

  const removeFolder = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`${config.foldersEndpoint}?id=${id}`, {
        method: "DELETE",
      });
      await readJsonBody(r, "Remove failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [config.foldersQueryKey] }),
    onError: (e: Error) => setError(e.message),
  });

  // A scan that reports itself as started is followed by polling rather than by
  // holding this request open for its whole run — see src/lib/drive/scanClient.ts
  // for why an open multi-minute request is how a browser ends up parsing an
  // nginx error page as JSON.
  const scan = useMutation({
    mutationFn: async (vars: { retryNow?: boolean } = {}): Promise<ScanSummary> => {
      const normalise = (r: ScanRunResult): ScanSummary => ({
        ...r,
        folders_scanned: r.folders_scanned ?? 0,
        unsupported: r.unsupported ?? 0,
      });
      const result = await startScanAndWait({
        scanEndpoint: config.scanEndpoint,
        statusEndpoint: config.statusEndpoint,
        body: vars.retryNow ? { retry_now: true } : undefined,
        // A drain runs for as long as the folder needs. Showing each poll turns
        // a multi-minute spinner into something that visibly counts up.
        onProgress: (r) => setSummary(normalise(r)),
      });
      return normalise(result);
    },
    onSuccess: (s) => {
      setSummary(s);
      setError(null);
      // Every surface that reads the table this scanner writes, in one go.
      for (const key of config.invalidateKeys) {
        qc.invalidateQueries({ queryKey: key });
      }
    },
    onError: (e: Error) => setError(e.message),
  });

  const activeCount = folders.filter((f) => f.is_active).length;

  return (
    <div
      className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm space-y-5"
      data-testid={config.testId}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">{config.title}</h2>
          <p className="text-xs text-gray-500 mt-0.5">{config.description}</p>
        </div>
        <Button
          type="button"
          onClick={() => scan.mutate({})}
          disabled={scan.isPending || activeCount === 0 || !driveConfigured}
          className="bg-brand-600 hover:bg-brand-700 text-white"
        >
          {scan.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4 mr-2" />
          )}
          {config.scanLabel}
        </Button>
      </div>

      {!driveConfigured && !isLoading && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
          <CloudOff className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Google Drive is not configured on this server. Set{" "}
            <code className="font-mono">GOOGLE_SERVICE_ACCOUNT_EMAIL</code> and{" "}
            <code className="font-mono">GOOGLE_PRIVATE_KEY</code>, and enable the Drive
            API for that service account.
          </span>
        </div>
      )}

      {/* Add a folder */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[280px]">
          <label className="block text-xs font-semibold text-gray-700 mb-1.5 uppercase tracking-wider">
            Add a folder
          </label>
          <input
            className={inputCls}
            placeholder="Paste the Drive folder link, or its id"
            value={folderInput}
            onChange={(e) => setFolderInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && folderInput.trim()) addFolder.mutate(folderInput.trim());
            }}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => addFolder.mutate(folderInput.trim())}
          disabled={!folderInput.trim() || addFolder.isPending || !driveConfigured}
        >
          {addFolder.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <FolderPlus className="w-4 h-4 mr-2" />
          )}
          Add
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Folder list */}
      {isLoading ? (
        <p className="text-xs text-gray-500 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading folders…
        </p>
      ) : folders.length === 0 ? (
        <p className="text-xs text-gray-500">{config.emptyHint}</p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100">
          {folders.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-[200px]">
                <p className="text-sm font-medium text-gray-900">
                  {f.label || f.drive_folder_id}
                </p>
                <p className="text-[11px] text-gray-500 font-mono">
                  {f.drive_folder_id}
                  {f.recursive ? " · includes sub-folders" : ""} · last scanned{" "}
                  {fmtWhen(f.last_scanned_at)}
                </p>
                {/* Visible, not buried in config — this setting is the
                    difference between booking the company's spend and booking
                    its entire turnover. */}
                {f.include_names?.trim() ? (
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    {config.includeHint(tokenList(f.include_names))}
                  </p>
                ) : (
                  <p className="text-[11px] text-amber-700 mt-0.5">
                    {config.noFilterWarning}
                  </p>
                )}
                <CoverageLine coverage={coverageByFolder.get(f.id)} />
              </div>
              <button
                type="button"
                onClick={() => toggleFolder.mutate({ id: f.id, is_active: !f.is_active })}
                disabled={toggleFolder.isPending}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold ${
                  f.is_active
                    ? "bg-green-50 text-green-700 border border-green-200"
                    : "bg-gray-100 text-gray-500 border border-gray-200"
                }`}
              >
                {f.is_active ? "Active" : "Paused"}
              </button>
              <button
                type="button"
                onClick={() => removeFolder.mutate(f.id)}
                disabled={removeFolder.isPending}
                title={config.removeTitle}
                className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Last run */}
      {summary && <ScanSummaryBlock summary={summary} />}
    </div>
  );
}

/**
 * The lifetime split for one folder.
 *
 * Exists because "Scanned 333 files — 0 new (333 unchanged, not re-read)" is
 * the same sentence whether every file imported or every file is stuck on a
 * dead API key, and the panel offered nothing else to tell them apart. The
 * last line is the actionable half: how many the NEXT scan will pick up.
 */
function CoverageLine({ coverage: c }: { coverage?: FolderCoverage }) {
  if (!c || c.total === 0) return null;

  const parts = [
    `${c.imported} imported`,
    c.expense_rows ? `${c.expense_rows} expense rows` : null,
    c.duplicate ? `${c.duplicate} duplicate` : null,
    c.needs_attention ? `${c.needs_attention} need attention` : null,
    c.unsupported ? `${c.unsupported} unsupported` : null,
    c.failed ? `${c.failed} failed` : null,
  ].filter(Boolean);

  return (
    <p className="text-[11px] text-gray-500 mt-0.5">
      <span className="font-semibold text-gray-700">{c.total} files on record</span>
      {" · "}
      {parts.join(" · ")}
      {c.retryable > 0 && (
        <span className="text-amber-700">
          {" — "}
          {c.retryable} will be retried on the next scan.
        </span>
      )}
    </p>
  );
}

function ScanSummaryBlock({ summary: s }: { summary: ScanSummary }) {
  // A drain runs until the folder is finished, which can be many minutes. The
  // counters are flushed to the run row as it goes, so show them moving rather
  // than a spinner that says nothing — "read 42 of 333" is the difference
  // between a scan that is working and one that has hung.
  if (s.status === "running" || s.status === "started") {
    return (
      <div className="p-3 rounded-xl bg-gray-50 border border-gray-200 text-xs text-gray-700 flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-500" />
        <span>
          Scanning…{" "}
          {s.files_seen > 0 ? (
            <>
              read <span className="font-semibold">{s.files_new}</span> of {s.files_seen}{" "}
              file{s.files_seen === 1 ? "" : "s"} · {s.imported} imported
              {s.failed > 0 && ` · ${s.failed} failed`}
            </>
          ) : (
            "listing the folder…"
          )}
        </span>
      </div>
    );
  }

  if (s.status === "skipped") {
    return (
      <div className="p-3 rounded-xl bg-gray-50 border border-gray-200 text-xs text-gray-700">
        {s.skipped_reason || "Nothing to scan."}
      </div>
    );
  }

  const tiles: Array<{ label: string; value: number; tone: string }> = [
    { label: "Imported", value: s.imported, tone: "text-green-700" },
    { label: "Needs attention", value: s.needs_attention, tone: "text-amber-700" },
    { label: "Duplicates skipped", value: s.skipped_duplicate, tone: "text-gray-600" },
    { label: "Unsupported", value: s.unsupported, tone: "text-gray-600" },
    { label: "Failed", value: s.failed, tone: "text-red-700" },
  ];

  return (
    <div
      className={`p-4 rounded-xl border ${
        s.status === "failed" ? "bg-red-50 border-red-200" : "bg-gray-50 border-gray-200"
      } space-y-3`}
    >
      <p className="text-xs font-semibold text-gray-800 flex items-center gap-2">
        {s.status === "failed" ? (
          <AlertTriangle className="w-3.5 h-3.5 text-red-600" />
        ) : (
          <Check className="w-3.5 h-3.5 text-green-600" />
        )}
        Scanned {s.files_seen} file{s.files_seen === 1 ? "" : "s"} across{" "}
        {s.folders_scanned} folder{s.folders_scanned === 1 ? "" : "s"} — {s.files_new} new
        {/* files_seen minus files_new is what the md5 dedup saved in model calls */}
        {s.files_seen > s.files_new && (
          <span className="font-normal text-gray-500">
            ({s.files_seen - s.files_new} unchanged, not re-read)
          </span>
        )}
      </p>

      <div className="flex flex-wrap gap-4">
        {tiles.map((t) => (
          <div key={t.label}>
            <p className={`text-lg font-semibold ${t.tone}`}>{t.value}</p>
            <p className="text-[11px] text-gray-500 uppercase tracking-wider">{t.label}</p>
          </div>
        ))}
      </div>

      {s.error && <p className="text-xs text-red-800">{s.error}</p>}
    </div>
  );
}
