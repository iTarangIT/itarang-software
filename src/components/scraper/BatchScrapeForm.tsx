"use client";

import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Download,
  FileSpreadsheet,
  Layers,
  Loader2,
  Sparkles,
  Upload,
  X,
} from "lucide-react";

// E-241 — the batch submission form.
//
// Two ways in, one submission out. Either the operator types lists into the two
// textareas (commands × cities, crossed here) or they upload a spreadsheet that
// has already crossed them. Whichever they used, the result is a flat list of
// (query, city) pairs and each pair becomes its own independent scrape.
//
// The number of jobs is shown live and everywhere, because it is the one thing
// that decides whether this click costs a rupee or a few thousand: with AI
// expansion on, each job fans out to ~15 billed QStash messages.

const MAX_COMMANDS = 25;
const MAX_CITIES = 50;

const WEEKDAYS = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
] as const;

type ScheduleMode = "now" | "once" | "daily";

interface ParsedRow {
  rowIndex: number;
  status: "valid" | "error";
  data: { query: string; city: string | null; max_results: number | null } | null;
  errors: string[];
}

interface ParseResult {
  rows: ParsedRow[];
  validCount: number;
  errorCount: number;
  queries: number;
  cities: number;
  truncated: number;
  fatal: string | null;
  over_cap: boolean;
  limits: { max_rows: number; max_jobs: number };
}

interface BatchScrapeFormProps {
  onSubmitted?: (batchId: string, queued: number) => void;
  onError?: (message: string) => void;
}

// Mirrors parseCommands/parseCities on the server so the live count the
// operator sees is the count the server will compute. The server re-splits from
// the raw text regardless — this is a preview, not the parse of record.
function splitList(raw: string, cap: number): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\n\r]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, cap);
}

export function BatchScrapeForm({ onSubmitted, onError }: BatchScrapeFormProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [commandsText, setCommandsText] = useState("");
  const [citiesText, setCitiesText] = useState("");
  const [expandWithAi, setExpandWithAi] = useState(false);

  const [mode, setMode] = useState<ScheduleMode>("now");
  const [runAt, setRunAt] = useState("");
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("18:00");
  const [days, setDays] = useState<string[]>([
    "mon",
    "tue",
    "wed",
    "thu",
    "fri",
  ]);

  const [upload, setUpload] = useState<ParseResult | null>(null);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const commands = useMemo(
    () => splitList(commandsText, MAX_COMMANDS),
    [commandsText],
  );
  const cities = useMemo(() => splitList(citiesText, MAX_CITIES), [citiesText]);

  // A file, once uploaded, REPLACES the textareas as the source of jobs — two
  // competing definitions of "what am I about to run" is exactly the ambiguity
  // that makes a batch form dangerous.
  const usingFile = !!upload && upload.validCount > 0;

  const jobCount = usingFile
    ? upload!.validCount
    : commands.length * Math.max(cities.length, 1);

  const cap = expandWithAi ? 100 : 500;
  const overCap = jobCount > cap;
  const estimatedChunks = jobCount * (expandWithAi ? 15 : 1);

  const scheduleValid =
    mode === "now" ||
    (mode === "once" && !!runAt) ||
    (mode === "daily" && !!windowStart && !!windowEnd && windowStart !== windowEnd);

  const blocked =
    submitting ||
    parsing ||
    jobCount === 0 ||
    overCap ||
    !scheduleValid ||
    (!!upload && (!!upload.fatal || upload.errorCount > 0));

  function clearUpload() {
    setUpload(null);
    setUploadName(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFile(file: File) {
    setParsing(true);
    setUpload(null);
    setUploadName(file.name);
    try {
      let csvText: string;

      if (/\.(xlsx|xls)$/i.test(file.name)) {
        // Lazy import so ~400 KB of SheetJS never enters the main bundle —
        // the same trick the admin UploadWizard uses. The server only ever
        // sees CSV, so it never has to parse a binary workbook.
        const XLSX = await import("xlsx");
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        if (!sheet) throw new Error("The workbook has no sheets.");
        csvText = XLSX.utils.sheet_to_csv(sheet);
      } else {
        csvText = await file.text();
      }

      const form = new FormData();
      form.append(
        "file",
        new Blob([csvText], { type: "text/csv" }),
        file.name.replace(/\.(xlsx|xls)$/i, ".csv"),
      );
      form.append("expand_with_ai", String(expandWithAi));

      const res = await fetch("/api/scraper/batch/parse", {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (!json.success) {
        onError?.(json.error?.message || "Could not read that file");
        clearUpload();
        return;
      }
      setUpload(json.data as ParseResult);
    } catch (err) {
      console.error(err);
      onError?.(
        err instanceof Error ? err.message : "Could not read that file",
      );
      clearUpload();
    } finally {
      setParsing(false);
    }
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        expand_with_ai: expandWithAi,
        schedule:
          mode === "now"
            ? { mode: "now" }
            : mode === "once"
              ? { mode: "once", run_after: new Date(runAt).toISOString() }
              : {
                  mode: "daily",
                  window_start: windowStart,
                  window_end: windowEnd,
                  window_days: days.length ? days : null,
                },
      };

      if (usingFile) {
        body.pairs = upload!.rows
          .filter((r) => r.status === "valid" && r.data)
          .map((r) => r.data);
      } else {
        body.commands = commandsText;
        body.cities = citiesText;
      }

      const res = await fetch("/api/scraper/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) {
        onError?.(json.error?.message || "Failed to queue batch");
        return;
      }

      setCommandsText("");
      setCitiesText("");
      clearUpload();
      queryClient.invalidateQueries({ queryKey: ["scraper-batches"] });
      onSubmitted?.(json.data.batch_id, json.data.queued);
    } catch (err) {
      console.error(err);
      onError?.("Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4 border border-gray-200 rounded-xl p-4 bg-white">
      {/* ── Commands + cities ────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Commands
            <span className="ml-2 font-normal text-gray-400">
              comma or new-line separated, up to {MAX_COMMANDS}
            </span>
          </label>
          <textarea
            value={commandsText}
            onChange={(e) => setCommandsText(e.target.value)}
            disabled={usingFile}
            rows={4}
            placeholder={"lithium battery, sukhi battery, port lithium battery"}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:bg-gray-50 disabled:cursor-not-allowed"
          />
          {commands.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {commands.map((c) => (
                <span
                  key={c}
                  className="px-2 py-0.5 text-[11px] rounded-full bg-teal-50 text-teal-700 border border-teal-100"
                >
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Cities
            <span className="ml-2 font-normal text-gray-400">
              optional — blank lets AI pick
            </span>
          </label>
          <textarea
            value={citiesText}
            onChange={(e) => setCitiesText(e.target.value)}
            disabled={usingFile}
            rows={4}
            placeholder={"prayagraj, lucknow, kanpur"}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:bg-gray-50 disabled:cursor-not-allowed"
          />
          {cities.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {cities.map((c) => (
                <span
                  key={c}
                  className="px-2 py-0.5 text-[11px] rounded-full bg-gray-100 text-gray-600 border border-gray-200"
                >
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Excel ────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={parsing || submitting}
          className="gap-2 text-sm"
        >
          {parsing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Upload className="w-4 h-4" />
          )}
          {parsing ? "Reading…" : "Upload Excel / CSV"}
        </Button>

        <a
          href="/api/scraper/batch/template.xlsx"
          className="inline-flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900"
        >
          <Download className="w-4 h-4" />
          Download template
        </a>

        {uploadName && (
          <span className="inline-flex items-center gap-2 px-2 py-1 text-xs rounded-md bg-gray-100 text-gray-700">
            <FileSpreadsheet className="w-3.5 h-3.5" />
            {uploadName}
            <button
              type="button"
              onClick={clearUpload}
              className="text-gray-400 hover:text-gray-700"
              aria-label="Remove uploaded file"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </span>
        )}
      </div>

      {/* ── Upload preview ───────────────────────────────────────── */}
      {upload && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 px-3 py-2 bg-gray-50 text-xs">
            <span className="inline-flex items-center gap-1.5 text-green-700">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {upload.validCount} valid
            </span>
            {upload.errorCount > 0 && (
              <span className="inline-flex items-center gap-1.5 text-red-700">
                <AlertCircle className="w-3.5 h-3.5" />
                {upload.errorCount} with errors
              </span>
            )}
            <span className="text-gray-500">
              {upload.queries} quer{upload.queries === 1 ? "y" : "ies"} ·{" "}
              {upload.cities} cit{upload.cities === 1 ? "y" : "ies"}
            </span>
            {upload.truncated > 0 && (
              <span className="text-amber-700">
                {upload.truncated} row(s) beyond the {upload.limits.max_rows}-row
                limit were dropped
              </span>
            )}
          </div>

          {upload.fatal && (
            <div className="px-3 py-2 text-xs text-red-700 bg-red-50 border-t border-red-100">
              {upload.fatal}
            </div>
          )}

          {upload.errorCount > 0 && (
            <div className="max-h-48 overflow-y-auto border-t border-gray-100">
              <table className="w-full text-xs">
                <thead className="bg-white sticky top-0">
                  <tr className="text-left text-gray-500">
                    <th className="px-3 py-1.5 font-medium w-16">Row</th>
                    <th className="px-3 py-1.5 font-medium">Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {upload.rows
                    .filter((r) => r.status === "error")
                    .map((r) => (
                      <tr key={r.rowIndex} className="border-t border-gray-50">
                        <td className="px-3 py-1.5 text-gray-500">
                          {r.rowIndex}
                        </td>
                        <td className="px-3 py-1.5 text-red-700">
                          {r.errors.join("; ")}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {upload.errorCount > 0 && (
            <div className="px-3 py-2 text-[11px] text-gray-500 border-t border-gray-100">
              Fix these rows in your file and upload it again — nothing is queued
              while any row is invalid.
            </div>
          )}
        </div>
      )}

      {/* ── AI expansion ─────────────────────────────────────────── */}
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={expandWithAi}
          onChange={(e) => setExpandWithAi(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
        />
        <span className="text-sm">
          <span className="inline-flex items-center gap-1.5 font-medium text-gray-800">
            <Sparkles className="w-3.5 h-3.5 text-amber-500" />
            Expand queries with AI
          </span>
          <span className="block text-xs text-gray-500 mt-0.5">
            {expandWithAi
              ? `Each command becomes ~15 phrasings — about ${estimatedChunks.toLocaleString()} searches, and the limit drops to ${cap} jobs.`
              : `Off: your commands are used exactly as typed — about ${estimatedChunks.toLocaleString()} search${estimatedChunks === 1 ? "" : "es"}. Cheaper and predictable.`}
          </span>
        </span>
      </label>

      {/* ── Schedule ─────────────────────────────────────────────── */}
      <div className="border-t border-gray-100 pt-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
          <Clock className="w-3.5 h-3.5" />
          Schedule
          <span className="font-normal text-gray-400">all times IST</span>
        </div>

        <div className="flex flex-wrap gap-4 text-sm">
          {(
            [
              ["now", "Run now"],
              ["once", "Run once at…"],
              ["daily", "Daily window"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="scraper-batch-schedule"
                checked={mode === value}
                onChange={() => setMode(value)}
                className="w-3.5 h-3.5 text-teal-600 focus:ring-teal-500"
              />
              <span className="text-gray-700">{label}</span>
            </label>
          ))}
        </div>

        {mode === "once" && (
          <input
            type="datetime-local"
            value={runAt}
            onChange={(e) => setRunAt(e.target.value)}
            className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
        )}

        {mode === "daily" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <input
                type="time"
                value={windowStart}
                onChange={(e) => setWindowStart(e.target.value)}
                className="px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
              <span className="text-gray-400">to</span>
              <input
                type="time"
                value={windowEnd}
                onChange={(e) => setWindowEnd(e.target.value)}
                className="px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {WEEKDAYS.map((d) => {
                const on = days.includes(d.key);
                return (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() =>
                      setDays((prev) =>
                        prev.includes(d.key)
                          ? prev.filter((x) => x !== d.key)
                          : [...prev, d.key],
                      )
                    }
                    className={`px-2.5 py-1 text-xs rounded-md border ${
                      on
                        ? "bg-teal-600 text-white border-teal-600"
                        : "bg-white text-gray-500 border-gray-200"
                    }`}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-gray-500">
              Jobs run only inside this window and pick up again the next
              selected day, until every job in the batch is done. A job already
              running when the window closes finishes.
              {windowEnd < windowStart && windowEnd !== windowStart && (
                <span className="text-amber-700">
                  {" "}
                  This window crosses midnight.
                </span>
              )}
            </p>
            {windowStart === windowEnd && (
              <p className="text-[11px] text-red-600">
                Start and end cannot be the same time.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Summary + submit ─────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-3">
        <p className="text-sm text-gray-600 inline-flex items-center gap-1.5">
          <Layers className="w-4 h-4 text-gray-400" />
          {jobCount === 0 ? (
            <span className="text-gray-400">
              Nothing to queue yet — add commands or upload a file.
            </span>
          ) : usingFile ? (
            <span>
              <strong className="text-gray-900">{jobCount}</strong> job
              {jobCount === 1 ? "" : "s"} from your file, run one at a time
            </span>
          ) : (
            <span>
              <strong className="text-gray-900">{commands.length}</strong> command
              {commands.length === 1 ? "" : "s"}
              {cities.length > 0 ? (
                <>
                  {" × "}
                  <strong className="text-gray-900">{cities.length}</strong> cit
                  {cities.length === 1 ? "y" : "ies"}
                </>
              ) : (
                " (AI-picked cities)"
              )}
              {" = "}
              <strong className="text-gray-900">{jobCount}</strong> job
              {jobCount === 1 ? "" : "s"}, run one at a time
            </span>
          )}
        </p>

        <Button
          onClick={handleSubmit}
          disabled={blocked}
          className="bg-teal-600 hover:bg-teal-700 text-white gap-2"
        >
          {submitting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Layers className="w-4 h-4" />
          )}
          {submitting ? "Queuing…" : `Queue ${jobCount || ""} job${jobCount === 1 ? "" : "s"}`}
        </Button>
      </div>

      {overCap && (
        <p className="text-xs text-red-600 inline-flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          {jobCount} jobs exceeds the limit of {cap}
          {expandWithAi
            ? " while AI expansion is on. Turn it off to allow up to 500."
            : ". Use fewer commands or cities."}
        </p>
      )}
    </div>
  );
}
