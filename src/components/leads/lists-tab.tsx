"use client";

// "Lists" tab for the Start AI Dialer modal — the third way to dial (next to
// Saved Groups / Custom Selection). Upload an Excel/CSV of leads → it creates a
// DRAFT campaign ("Ready") → press Start to launch it. List campaigns are
// fetched from /api/ai-dialer/campaigns?kind=list and run through the same
// pipeline as region campaigns.

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CampaignWindowPicker,
  INITIAL_SCHEDULE,
  isScheduleInvalid,
  toSchedulePayload,
  useScheduleDefaults,
  type CampaignScheduleValue,
} from "./campaign-window-picker";
import Link from "next/link";
import {
  Plus,
  UploadCloud,
  FileSpreadsheet,
  X,
  Loader2,
  Phone,
  ArrowUpRight,
  ListChecks,
  CheckCircle2,
} from "lucide-react";
import { CampaignStatusBadge } from "./campaign-status-badge";

type ListProvider = "bolna" | "elevenlabs";

type ListCampaignRow = {
  id: string;
  name: string;
  status: string;
  provider: string;
  totalLeads: number;
  callsMade: number;
  completedLeads: number;
  failedLeads: number;
  startedAt: string | null;
};

interface CreateSummary {
  name: string;
  total: number;
  imported: number;
  reused: number;
  updated: number;
  invalid: number;
  queued: number;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function ListsTab({
  provider,
  onStartList,
}: {
  provider: ListProvider;
  onStartList?: (
    campaignId: string,
    schedule: ReturnType<typeof toSchedulePayload>,
  ) => Promise<void> | void;
}) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [panelOpen, setPanelOpen] = useState(false);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<CreateSummary | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  // E-254 — one calling window for the tab, applied to whichever draft is
  // started. Deliberately not per-row: `provider` already works this way, a
  // picker inside every card would drown the list, and the operator starts one
  // list at a time anyway.
  const [schedule, setSchedule] =
    useState<CampaignScheduleValue>(INITIAL_SCHEDULE);
  useScheduleDefaults(setSchedule);

  const { data, isLoading } = useQuery({
    queryKey: ["dialer-list-campaigns"],
    queryFn: async () => {
      const res = await fetch("/api/ai-dialer/campaigns?kind=list&limit=50");
      const json = await res.json();
      if (!json.success) throw new Error("Failed to load lists");
      return json.data;
    },
    refetchInterval: (query) => {
      const rows = (query.state.data?.data ?? []) as ListCampaignRow[];
      return rows.some((r) => r.status === "running") ? 4000 : false;
    },
  });

  const campaigns = (data?.data ?? []) as ListCampaignRow[];

  const resetPanel = () => {
    setName("");
    setFile(null);
    setError(null);
    setCreating(false);
  };

  const pickFile = (f: File | null) => {
    setError(null);
    if (!f) return;
    const ok = /\.(xlsx|xls|csv)$/i.test(f.name);
    if (!ok) {
      setError("Please choose an .xlsx or .csv file.");
      return;
    }
    setFile(f);
  };

  const handleCreate = async () => {
    if (!name.trim() || !file || creating) return;
    setCreating(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("name", name.trim());
      fd.append("file", file);
      const res = await fetch("/api/ai-dialer/lists/create", {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json?.error?.message ?? "Could not create the campaign.");
        setCreating(false);
        return;
      }
      setSummary(json.data as CreateSummary);
      setPanelOpen(false);
      resetPanel();
      queryClient.invalidateQueries({ queryKey: ["dialer-list-campaigns"] });
    } catch (e: any) {
      setError(e?.message ?? "Upload failed. Please try again.");
      setCreating(false);
    }
  };

  const handleStart = async (id: string) => {
    if (startingId || isScheduleInvalid(schedule)) return;
    setStartingId(id);
    try {
      await onStartList?.(id, toSchedulePayload(schedule));
    } finally {
      setStartingId(null);
    }
  };

  return (
    <div className="lists-tab">
      <style jsx global>{`
        .lists-tab {
          padding: 12px 14px 14px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .lists-new-btn {
          width: 100%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 11px 14px;
          border-radius: 11px;
          border: 1px dashed #a7f3d0;
          background: linear-gradient(180deg, #f0fdf4 0%, #ffffff 100%);
          color: #047857;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: border-color 160ms ease, background 160ms ease,
            transform 160ms ease;
        }
        .lists-new-btn:hover {
          border-color: #34d399;
          background: #ecfdf5;
        }
        .lists-panel {
          border: 1px solid #e5e7eb;
          border-radius: 13px;
          background: #ffffff;
          box-shadow: 0 10px 30px -18px rgba(15, 23, 42, 0.25);
          overflow: hidden;
          animation: lists-slide 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        @keyframes lists-slide {
          from {
            opacity: 0;
            transform: translateY(-6px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .lists-panel-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 11px 13px;
          border-bottom: 1px solid #f3f4f6;
        }
        .lists-panel-title {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #6b7280;
        }
        .lists-panel-body {
          padding: 13px;
          display: flex;
          flex-direction: column;
          gap: 11px;
        }
        .lists-input {
          width: 100%;
          padding: 9px 11px;
          border: 1px solid #e5e7eb;
          border-radius: 9px;
          font-size: 13px;
          color: #111827;
          outline: none;
          transition: border-color 160ms ease, box-shadow 160ms ease;
        }
        .lists-input:focus {
          border-color: #34d399;
          box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.12);
        }
        .lists-input-label {
          display: block;
          font-size: 12px;
          font-weight: 600;
          color: #374151;
          margin-bottom: 5px;
        }
        .lists-drop {
          position: relative;
          border: 1.5px dashed #d1d5db;
          border-radius: 11px;
          background: #fafafa;
          padding: 18px 14px;
          text-align: center;
          cursor: pointer;
          transition: border-color 160ms ease, background 160ms ease;
        }
        .lists-drop:hover {
          border-color: #9ca3af;
          background: #f9fafb;
        }
        .lists-drop.is-drag {
          border-color: #10b981;
          background: #ecfdf5;
        }
        .lists-drop.has-file {
          border-style: solid;
          border-color: #a7f3d0;
          background: #f0fdf4;
          text-align: left;
        }
        .lists-drop-hint {
          font-size: 11px;
          color: #9ca3af;
          margin-top: 6px;
        }
        .lists-file-row {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .lists-file-meta {
          min-width: 0;
          flex: 1;
        }
        .lists-file-name {
          font-size: 13px;
          font-weight: 600;
          color: #065f46;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .lists-file-size {
          font-size: 11px;
          color: #6b7280;
        }
        .lists-panel-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
        }
        .lists-btn-ghost {
          padding: 8px 12px;
          font-size: 13px;
          color: #6b7280;
          background: transparent;
          border: none;
          border-radius: 8px;
          cursor: pointer;
        }
        .lists-btn-ghost:hover {
          color: #111827;
        }
        .lists-btn-primary {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 8px 14px;
          font-size: 13px;
          font-weight: 600;
          color: #ffffff;
          background: #059669;
          border: none;
          border-radius: 9px;
          cursor: pointer;
          transition: background 160ms ease, transform 160ms ease;
        }
        .lists-btn-primary:hover:not(:disabled) {
          background: #047857;
          transform: translateY(-1px);
        }
        .lists-btn-primary:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .lists-err {
          font-size: 12px;
          color: #b91c1c;
          background: #fef2f2;
          border: 1px solid #fecaca;
          border-radius: 8px;
          padding: 7px 10px;
        }
        .lists-summary {
          display: flex;
          align-items: center;
          gap: 9px;
          font-size: 12px;
          color: #065f46;
          background: #ecfdf5;
          border: 1px solid #a7f3d0;
          border-radius: 10px;
          padding: 9px 11px;
        }
        .lists-summary b {
          font-weight: 700;
        }
        .lists-scroll {
          display: flex;
          flex-direction: column;
          gap: 8px;
          max-height: 264px;
          overflow-y: auto;
          margin: 0 -2px;
          padding: 0 2px;
        }
        .lists-card {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 11px 12px;
          border: 1px solid #eceef1;
          border-left: 3px solid #c7d2fe;
          border-radius: 11px;
          background: #ffffff;
          transition: border-color 160ms ease, box-shadow 160ms ease;
        }
        .lists-card:hover {
          box-shadow: 0 6px 18px -12px rgba(15, 23, 42, 0.22);
        }
        .lists-card.is-running {
          border-left-color: #f59e0b;
        }
        .lists-card.is-done {
          border-left-color: #10b981;
        }
        .lists-card.is-dead {
          border-left-color: #d4d4d8;
        }
        .lists-card-main {
          min-width: 0;
          flex: 1;
        }
        .lists-card-name {
          font-size: 13.5px;
          font-weight: 600;
          color: #111827;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .lists-card-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 4px;
          font-size: 11.5px;
          color: #6b7280;
          font-variant-numeric: tabular-nums;
        }
        .lists-card-dot {
          width: 3px;
          height: 3px;
          border-radius: 999px;
          background: #d1d5db;
        }
        .lists-start {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 7px 13px;
          font-size: 12.5px;
          font-weight: 600;
          color: #ffffff;
          background: #059669;
          border: none;
          border-radius: 9px;
          cursor: pointer;
          white-space: nowrap;
          transition: background 160ms ease, transform 160ms ease;
        }
        .lists-start:hover:not(:disabled) {
          background: #047857;
          transform: translateY(-1px);
        }
        .lists-start:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .lists-view {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 7px 12px;
          font-size: 12.5px;
          font-weight: 600;
          color: #4338ca;
          background: #eef2ff;
          border: none;
          border-radius: 9px;
          cursor: pointer;
          white-space: nowrap;
          transition: background 160ms ease;
        }
        .lists-view:hover {
          background: #e0e7ff;
        }
        .lists-empty {
          text-align: center;
          padding: 22px 16px;
          color: #9ca3af;
        }
        .lists-empty-icon {
          width: 38px;
          height: 38px;
          border-radius: 11px;
          background: #f3f4f6;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 9px;
          color: #9ca3af;
        }
        .lists-skel {
          height: 56px;
          border-radius: 11px;
          background: linear-gradient(
            90deg,
            #f3f4f6 25%,
            #eceef1 37%,
            #f3f4f6 63%
          );
          background-size: 400% 100%;
          animation: lists-shimmer 1.4s ease infinite;
        }
        @keyframes lists-shimmer {
          0% {
            background-position: 100% 50%;
          }
          100% {
            background-position: 0 50%;
          }
        }
      `}</style>

      {/* Create entry point / panel */}
      {!panelOpen ? (
        <button
          type="button"
          className="lists-new-btn"
          onClick={() => {
            setSummary(null);
            setPanelOpen(true);
          }}
        >
          <Plus className="w-4 h-4" />
          Create Campaign from Excel
        </button>
      ) : (
        <div className="lists-panel">
          <div className="lists-panel-head">
            <span className="lists-panel-title">New list campaign</span>
            <button
              type="button"
              onClick={() => {
                setPanelOpen(false);
                resetPanel();
              }}
              className="text-gray-400 hover:text-gray-700"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="lists-panel-body">
            <div>
              <label className="lists-input-label">Campaign name</label>
              <input
                className="lists-input"
                placeholder="e.g. Gwalior dealers — June"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />

            {!file ? (
              <div
                className={`lists-drop ${dragOver ? "is-drag" : ""}`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  pickFile(e.dataTransfer.files?.[0] ?? null);
                }}
              >
                <div className="lists-empty-icon" style={{ margin: "0 auto 8px" }}>
                  <UploadCloud className="w-5 h-5 text-emerald-600" />
                </div>
                <div className="text-[13px] font-semibold text-gray-700">
                  Drop your Excel here, or{" "}
                  <span className="text-emerald-700">browse</span>
                </div>
                <div className="lists-drop-hint">
                  .xlsx / .csv — needs a phone column. Name, city, state &
                  language optional.
                </div>
              </div>
            ) : (
              <div className="lists-drop has-file">
                <div className="lists-file-row">
                  <FileSpreadsheet className="w-5 h-5 text-emerald-600 shrink-0" />
                  <div className="lists-file-meta">
                    <div className="lists-file-name">{file.name}</div>
                    <div className="lists-file-size">
                      {(file.size / 1024).toFixed(0)} KB
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFile(null)}
                    className="text-gray-400 hover:text-gray-700 shrink-0"
                    aria-label="Remove file"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {error && <div className="lists-err">{error}</div>}

            <div className="lists-panel-actions">
              <button
                type="button"
                className="lists-btn-ghost"
                onClick={() => {
                  setPanelOpen(false);
                  resetPanel();
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="lists-btn-primary"
                disabled={!name.trim() || !file || creating}
                onClick={handleCreate}
              >
                {creating ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Importing…
                  </>
                ) : (
                  <>
                    <Plus className="w-3.5 h-3.5" />
                    Create
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Post-create summary */}
      {summary && (
        <div className="lists-summary">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>
            <b>{summary.name}</b> ready — <b>{summary.queued}</b> to dial
            {summary.reused > 0 ? ` · ${summary.reused} reused` : ""}
            {summary.updated > 0 ? ` · ${summary.updated} updated` : ""}
            {summary.invalid > 0 ? ` · ${summary.invalid} skipped` : ""}.
            Press Start below.
          </span>
        </div>
      )}

      {/* E-254 — the calling window applied when Start is pressed below. */}
      <div className="px-1 pb-2">
        <CampaignWindowPicker
          value={schedule}
          onChange={setSchedule}
          idPrefix="lists-tab"
          compact
        />
      </div>

      {/* Campaign list */}
      {isLoading ? (
        <div className="lists-scroll">
          <div className="lists-skel" />
          <div className="lists-skel" />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="lists-empty">
          <div className="lists-empty-icon">
            <ListChecks className="w-5 h-5" />
          </div>
          <div className="text-[13px] font-medium text-gray-500">
            No lists yet
          </div>
          <div className="text-[11.5px] text-gray-400 mt-0.5">
            Upload an Excel to start your first list campaign.
          </div>
        </div>
      ) : (
        <div className="lists-scroll">
          {campaigns.map((c) => {
            const cls =
              c.status === "running"
                ? "is-running"
                : c.status === "completed"
                  ? "is-done"
                  : c.status === "stopped" || c.status === "failed"
                    ? "is-dead"
                    : "";
            return (
              <div key={c.id} className={`lists-card ${cls}`}>
                <div className="lists-card-main">
                  <div className="lists-card-name">{c.name}</div>
                  <div className="lists-card-meta">
                    <CampaignStatusBadge status={c.status} />
                    <span className="lists-card-dot" />
                    <span>{c.totalLeads} leads</span>
                    {c.status !== "draft" && (
                      <>
                        <span className="lists-card-dot" />
                        <span>{c.callsMade} called</span>
                      </>
                    )}
                    {c.startedAt && (
                      <>
                        <span className="lists-card-dot" />
                        <span>{fmtWhen(c.startedAt)}</span>
                      </>
                    )}
                  </div>
                </div>
                {c.status === "draft" ? (
                  <button
                    type="button"
                    className="lists-start"
                    title={`Start dialing via ${provider === "elevenlabs" ? "ElevenLabs" : "Bolna"}`}
                    disabled={startingId === c.id || isScheduleInvalid(schedule)}
                    onClick={() => handleStart(c.id)}
                  >
                    {startingId === c.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Phone className="w-3.5 h-3.5" />
                    )}
                    Start
                  </button>
                ) : (
                  <Link
                    href={`/leads/campaigns/${c.id}`}
                    className="lists-view"
                  >
                    View
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
