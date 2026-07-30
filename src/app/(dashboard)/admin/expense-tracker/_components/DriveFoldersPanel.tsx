"use client";

/**
 * E-216 — Google Drive folder management + "Scan now" for the expense tracker.
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

interface ScanSummary {
  run_id: string | null;
  status: "success" | "failed" | "skipped";
  folders_scanned: number;
  files_seen: number;
  files_new: number;
  imported: number;
  skipped_duplicate: number;
  needs_attention: number;
  unsupported: number;
  failed: number;
  duration_ms: number;
  error?: string;
  skipped_reason?: string;
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

export function DriveFoldersPanel() {
  const qc = useQueryClient();
  const [folderInput, setFolderInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ScanSummary | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["drive-folders"],
    queryFn: async () => {
      const r = await fetch("/api/admin/ai-expenses/drive/folders", {
        cache: "no-store",
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Failed to load");
      return j.data as { folders: DriveFolder[]; drive_configured: boolean };
    },
  });

  const folders = data?.folders ?? [];
  const driveConfigured = data?.drive_configured ?? false;

  const addFolder = useMutation({
    mutationFn: async (folder: string) => {
      const r = await fetch("/api/admin/ai-expenses/drive/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Could not add folder");
    },
    onSuccess: () => {
      setFolderInput("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["drive-folders"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const toggleFolder = useMutation({
    mutationFn: async (vars: { id: string; is_active: boolean }) => {
      const r = await fetch("/api/admin/ai-expenses/drive/folders", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(vars),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Update failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["drive-folders"] }),
    onError: (e: Error) => setError(e.message),
  });

  const removeFolder = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/ai-expenses/drive/folders?id=${id}`, {
        method: "DELETE",
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Remove failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["drive-folders"] }),
    onError: (e: Error) => setError(e.message),
  });

  const scan = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/ai-expenses/drive/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Scan failed");
      return j.data as ScanSummary;
    },
    onSuccess: (s) => {
      setSummary(s);
      setError(null);
      // Every surface that reads expense_submissions, in one go.
      for (const key of [
        ["drive-folders"],
        ["drive-runs"],
        ["drive-attention"],
        ["ai-expenses"],
        ["ai-expense-tags"],
        ["dashboard-metrics", "ceo"],
        ["ceo-expenses-summary"],
        ["ceo-snapshot-summary"],
      ]) {
        qc.invalidateQueries({ queryKey: key });
      }
    },
    onError: (e: Error) => setError(e.message),
  });

  const activeCount = folders.filter((f) => f.is_active).length;

  return (
    <div
      className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm space-y-5"
      data-testid="drive-folders-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Google Drive folders</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Invoices and costing sheets dropped in these folders are imported
            automatically every few hours.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => scan.mutate()}
          disabled={scan.isPending || activeCount === 0 || !driveConfigured}
          className="bg-brand-600 hover:bg-brand-700 text-white"
        >
          {scan.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4 mr-2" />
          )}
          Scan now
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
        <p className="text-xs text-gray-500">
          No folders yet. Share a Drive folder with the service account, then paste its
          link above.
        </p>
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
                    difference between importing expenses and importing the
                    company's entire turnover. */}
                {f.include_names?.trim() ? (
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Importing only what is inside folders named{" "}
                    <span className="font-medium text-gray-700">
                      {tokenList(f.include_names)}
                    </span>
                    . Sales invoices are revenue and come from Zoho, so they stay out.
                  </p>
                ) : (
                  <p className="text-[11px] text-amber-700 mt-0.5">
                    No purchase filter set — every folder in this tree is imported,
                    including customer invoices, which would double-count revenue as
                    expenses.
                  </p>
                )}
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
                title="Remove folder (imported expenses are kept)"
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

function ScanSummaryBlock({ summary: s }: { summary: ScanSummary }) {
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
