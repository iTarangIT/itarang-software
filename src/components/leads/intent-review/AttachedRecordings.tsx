"use client";

// Attach a call recording and watch the AI read it.
//
// The feature this serves: "instead of requiring lengthy manual explanations,
// let the reviewer attach the recording so the AI can transcribe, analyse and
// understand the conversation." An ASM who rang the dealer back on their own
// phone drops the audio here; a minute later it comes back with a transcript
// and a band derived by the SAME engine that scores dialer calls.
//
// Uploading deliberately does NOT move the lead. The recording carries its own
// band; the reviewer decides what it means by submitting a correction. Attaching
// evidence and ruling on it are two different acts.

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  FileAudio,
  Loader2,
  RefreshCw,
  Sparkles,
  Upload,
} from "lucide-react";

export interface AttachedRecording {
  id: string;
  callId: string | null;
  purpose: string;
  url: string;
  filename: string | null;
  sizeBytes: number | null;
  status: string;
  attempts: number;
  error: string | null;
  transcript: string | null;
  language: string | null;
  band: string | null;
  intentScore: number | null;
  infoSignalsCount: number | null;
  summary: string | null;
  createdAt: string | null;
  uploadedByName: string | null;
}

const PURPOSE_LABEL: Record<string, string> = {
  human_call: "Follow-up call",
  ai_reanalysis: "Re-read of the AI call",
  evidence: "Evidence only",
};

const BAND_CLASS: Record<string, string> = {
  Qualified: "bg-emerald-100 text-emerald-800 border-emerald-200",
  Warm: "bg-amber-100 text-amber-800 border-amber-200",
  Cold: "bg-sky-100 text-sky-800 border-sky-200",
  Disqualified: "bg-gray-200 text-gray-700 border-gray-300",
};

function humanSize(bytes: number | null): string {
  if (!bytes) return "";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachedRecordings({
  leadId,
  callId,
  canReview,
  hasAiRecording,
}: {
  leadId: string;
  /** The AI call in view, so an upload can be tied to it. */
  callId: string | null;
  canReview: boolean;
  /** Whether the AI call has stored audio worth re-reading. */
  hasAiRecording: boolean;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [purpose, setPurpose] = useState<string>("human_call");
  const [error, setError] = useState<string | null>(null);
  const [openTranscript, setOpenTranscript] = useState<string | null>(null);

  const listKey = ["lead-recordings", leadId];

  const { data } = useQuery<{ recordings: AttachedRecording[] }>({
    queryKey: listKey,
    queryFn: async () => {
      const res = await fetch(
        `/api/dealer-leads/${encodeURIComponent(leadId)}/recordings?include=transcript`,
      );
      const json = await res.json();
      return json?.success ? json.data : { recordings: [] };
    },
    // Poll only while something is actually in flight. A lead whose recordings
    // are all finished must not keep a timer running on every open screen.
    refetchInterval: (query) => {
      const rows = query.state.data?.recordings ?? [];
      return rows.some((r) => r.status === "pending" || r.status === "running")
        ? 5000
        : false;
    },
  });

  const recordings = data?.recordings ?? [];

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      form.append("purpose", purpose);
      if (callId) form.append("callId", callId);

      // Same-origin multipart, NOT a presigned PUT to S3: the bucket has no
      // CORS rule and the app's IAM user cannot add one, so a direct browser
      // PUT dies in preflight with a bare "Failed to fetch".
      const res = await fetch(
        `/api/dealer-leads/${encodeURIComponent(leadId)}/recordings`,
        { method: "POST", body: form },
      );
      const json = await res.json();
      if (!json.success)
        throw new Error(json.error?.message ?? "Upload failed");
      return json.data;
    },
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Upload failed"),
  });

  const reanalyse = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/dealer-leads/${encodeURIComponent(leadId)}/recordings/reanalyse`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callId }),
        },
      );
      const json = await res.json();
      if (!json.success)
        throw new Error(json.error?.message ?? "Re-analysis failed");
      return json.data;
    },
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (e) =>
      setError(e instanceof Error ? e.message : "Re-analysis failed"),
  });

  if (!canReview && recordings.length === 0) return null;

  return (
    // Card chrome matches AiSignalsPanel's "panel" variant directly above it and
    // the collapsible groups below — rounded-xl / border-gray-100. The earlier
    // rounded-2xl + border-gray-200 read as a heavier, foreign box stacked
    // between two lighter ones.
    <section className="rounded-xl border border-gray-100 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 flex items-center gap-1.5">
          <FileAudio className="w-3.5 h-3.5" />
          Attached recordings
        </h3>
        {recordings.length > 0 && (
          <span className="text-[11px] font-medium text-gray-400 tabular-nums">
            {recordings.length}
          </span>
        )}
      </div>

      {/* ── The control stack ──
          This pane is the 2fr of a lg:grid-cols-[3fr_2fr] split — roughly 470px
          of usable width. The controls were previously a single horizontal row
          (select + two buttons), which does not fit: "Re-read AI call" wrapped
          onto three lines and the row collapsed into a ragged block.

          So the select takes the full width on its own line, and the two actions
          sit on an equal-width 2-col grid beneath it. A grid rather than flex on
          purpose — equal columns mean neither button's label length can push the
          other into wrapping, whatever the container does. */}
      {canReview && (
        <div className="mt-3 space-y-2">
          <select
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            aria-label="What this recording is for"
            className="w-full h-9 rounded-lg border border-gray-200 bg-white px-2.5 text-xs text-gray-700 focus:border-gray-400 focus:outline-none"
          >
            <option value="human_call">
              Follow-up call — transcribe &amp; score
            </option>
            <option value="evidence">
              Evidence only — don&apos;t transcribe
            </option>
          </select>

          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.target.value = "";
            }}
          />

          <div
            className={`grid gap-2 ${
              hasAiRecording && callId ? "grid-cols-2" : "grid-cols-1"
            }`}
          >
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={upload.isPending}
              className="h-9 px-3 rounded-lg bg-gray-900 text-white text-xs font-semibold hover:bg-gray-800 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              {upload.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
              ) : (
                <Upload className="w-3.5 h-3.5 shrink-0" />
              )}
              <span className="truncate">Attach audio</span>
            </button>

            {hasAiRecording && callId && (
              <button
                type="button"
                onClick={() => reanalyse.mutate()}
                disabled={reanalyse.isPending}
                title="Re-transcribe the AI call's own audio and score it again — useful when the provider's transcript came back garbled."
                className="h-9 px-3 rounded-lg border border-gray-200 text-xs font-semibold text-gray-700 hover:border-gray-400 hover:bg-gray-50 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
              >
                {reanalyse.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                )}
                <span className="truncate">Re-read call</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* One quiet line, not a paragraph. The full reasoning for the 25 MB
          ceiling (it is the transcription service's limit, ~50 min of phone
          audio) lives in the tooltip and in the rejection message you get if you
          exceed it — which is where it is actually needed. Spending two lines of
          body text on it up front made the format hint the loudest thing in the
          card. */}
      {canReview && (
        <p
          className="mt-2 text-[11px] text-gray-400"
          title="25 MB is the transcription service's own limit — roughly 50 minutes of phone audio."
        >
          mp3 · m4a · wav · webm · ogg · flac — max 25 MB
        </p>
      )}

      {error && (
        <p className="mt-2 text-[11px] text-red-600 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 mt-px shrink-0" />
          {error}
        </p>
      )}

      {recordings.length === 0 ? (
        <p className="mt-3 text-[11px] italic text-gray-400">
          Nothing attached yet.
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {recordings.map((r) => (
            <li key={r.id} className="rounded-xl border border-gray-100 p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-[11px] font-semibold text-gray-700">
                  {PURPOSE_LABEL[r.purpose] ?? r.purpose}
                  {r.filename && (
                    <span className="font-normal text-gray-400">
                      {" "}
                      · {r.filename}
                    </span>
                  )}
                  {r.sizeBytes != null && (
                    <span className="font-normal text-gray-400">
                      {" "}
                      · {humanSize(r.sizeBytes)}
                    </span>
                  )}
                </span>

                {r.band && (
                  <span
                    className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${
                      BAND_CLASS[r.band] ??
                      "bg-gray-100 text-gray-700 border-gray-200"
                    }`}
                  >
                    {r.band}
                    {r.infoSignalsCount != null && (
                      <> · {r.infoSignalsCount}/5</>
                    )}
                  </span>
                )}
              </div>

              <audio
                controls
                preload="none"
                src={r.url}
                className="mt-2 w-full h-8"
              />

              <StatusLine recording={r} />

              {r.summary && (
                <p className="mt-2 text-[11px] text-gray-600">{r.summary}</p>
              )}

              {r.transcript && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setOpenTranscript((cur) => (cur === r.id ? null : r.id))
                    }
                    className="mt-2 text-[11px] font-semibold text-gray-600 hover:text-gray-900 underline underline-offset-2"
                  >
                    {openTranscript === r.id
                      ? "Hide transcript"
                      : "Read transcript"}
                  </button>
                  {openTranscript === r.id && (
                    // Plain scrollable text, not turn-by-turn bubbles. The
                    // default transcription model (gpt-4o-transcribe) returns
                    // text only — no speaker labels and no timestamps. Faking
                    // speakers here would invent structure the audio never gave
                    // us.
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-700">
                      {r.transcript}
                    </pre>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusLine({ recording: r }: { recording: AttachedRecording }) {
  if (r.status === "pending" || r.status === "running") {
    return (
      <p className="mt-2 text-[11px] text-gray-500 flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin" />
        {r.status === "running"
          ? "Transcribing and scoring…"
          : "Queued for transcription…"}
        {r.attempts > 1 && (
          <span className="text-gray-400">(attempt {r.attempts})</span>
        )}
      </p>
    );
  }

  if (r.status === "failed") {
    return (
      <p className="mt-2 text-[11px] text-red-600 flex items-start gap-1">
        <AlertTriangle className="w-3 h-3 mt-px shrink-0" />
        {r.error || "Transcription failed."}
      </p>
    );
  }

  if (r.status === "skipped") {
    return (
      <p className="mt-2 text-[11px] text-gray-400">
        Stored as evidence — not transcribed.
      </p>
    );
  }

  // done. `error` is still worth showing here: a recording can transcribe
  // successfully and fail to SCORE, and silently dropping that would leave a
  // transcript with no band and no explanation for why.
  return (
    <p className="mt-2 text-[11px] text-gray-500 flex items-start gap-1.5">
      <Sparkles className="w-3 h-3 mt-px shrink-0 text-gray-400" />
      {r.error ? (
        <span className="text-amber-700">{r.error}</span>
      ) : (
        <>
          Read by the AI
          {r.language && <> · {r.language}</>}
          {r.uploadedByName && <> · attached by {r.uploadedByName}</>}
        </>
      )}
    </p>
  );
}
