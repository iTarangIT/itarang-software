"use client";

// The AI call's own recording and transcript, on the lead-detail screen.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The review flow is "read the transcript → check the signals → listen to the
// call → correct the band". Until now the middle two were on the lead screen and
// the transcript was not: it lived only in the campaign drawer's separate
// "Transcription" tab, reachable from a campaign screen. So a reviewer on a lead
// could see that the AI marked `battery_spec_shared = no` and had no way to read
// the line where the dealer said "60V 100Ah" — they were asked to judge a
// verdict without the evidence.
//
// The "AI Call History" tab does show per-attempt cards with an audio player,
// but no transcript text, and it needs a campaignId — a manually-dialled lead
// has none.
//
// ── WHY THE TRANSCRIPT IS FETCHED LAZILY ─────────────────────────────────────
// /api/dealer-leads/[id]/ai-summary makes the transcript opt-in behind
// ?include=transcript, because it is a large text column and the panel used not
// to render it. That reasoning still holds for the ~97% of opens where nobody
// reads it, so this asks for the transcript only when the reviewer expands it,
// under its own query key. The card's normal payload stays small.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FileText, Loader2 } from "lucide-react";

/**
 * Split a flat provider transcript into speaker turns.
 *
 * Bolna stores one string with `agent:` / `user:` line prefixes, in Hindi,
 * English or Hinglish. Rendering that raw is a wall of text in which the only
 * thing that matters for scoring — what the DEALER said — is indistinguishable
 * from the agent's script.
 *
 * Falls back to a single untagged block whenever the prefixes are absent, which
 * is the case for older rows and for any provider that stores plain prose. A
 * parser that assumed the format would render those as one giant "agent" turn,
 * silently attributing the dealer's words to the bot.
 */
export function parseTurns(
  transcript: string,
): Array<{ speaker: "agent" | "dealer" | null; text: string }> {
  const lines = transcript.split("\n").filter((l) => l.trim().length > 0);

  const tagged = lines.filter((l) =>
    /^\s*(agent|user|assistant|human)\s*:/i.test(l),
  );
  // Require most lines to carry a prefix before trusting the format — one stray
  // "note:" in prose must not switch on turn parsing for the whole transcript.
  if (tagged.length < Math.max(2, lines.length * 0.5)) {
    return [{ speaker: null, text: transcript.trim() }];
  }

  return lines.map((line) => {
    const m = line.match(/^\s*(agent|user|assistant|human)\s*:\s*(.*)$/i);
    if (!m) return { speaker: null, text: line.trim() };
    const who = m[1].toLowerCase();
    return {
      speaker: who === "agent" || who === "assistant" ? "agent" : "dealer",
      text: m[2].trim(),
    };
  });
}

type Summary = {
  latest: { transcript: string | null } | null;
};

export function CallTranscript({
  leadId,
  recordingUrl,
  hasTranscript,
}: {
  leadId: string;
  /** The AI call's stored audio, if any. */
  recordingUrl: string | null;
  /** From the summary payload — whether there is anything to expand. */
  hasTranscript: boolean;
}) {
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useQuery<Summary | null>({
    queryKey: ["lead-ai-transcript", leadId],
    enabled: open && hasTranscript,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await fetch(
        `/api/dealer-leads/${encodeURIComponent(leadId)}/ai-summary?include=transcript`,
      );
      const json = await res.json();
      return json?.success ? (json.data as Summary) : null;
    },
  });

  const transcript = data?.latest?.transcript ?? null;
  const turns = transcript ? parseTurns(transcript) : [];

  if (!recordingUrl && !hasTranscript) return null;

  return (
    <div className="space-y-2">
      {/* The AI call's own audio. AiSignalsPanel has carried recordingUrl in its
          props all along without ever rendering a player — so on the lead screen
          the recording was reachable only by opening the campaign drawer. */}
      {recordingUrl && (
        <audio
          controls
          preload="none"
          src={recordingUrl}
          className="w-full h-8"
        />
      )}

      {hasTranscript && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="w-full h-9 rounded-lg border border-gray-200 text-xs font-semibold text-gray-700 hover:border-gray-400 hover:bg-gray-50 inline-flex items-center justify-center gap-1.5"
          >
            <FileText className="w-3.5 h-3.5 shrink-0" />
            {open ? "Hide transcript" : "Read transcript"}
            <ChevronDown
              className={`w-3.5 h-3.5 shrink-0 transition ${open ? "rotate-180" : ""}`}
            />
          </button>

          {open && (
            <div className="max-h-72 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50/60 p-2.5">
              {isLoading && (
                <p className="text-[11px] text-gray-400 flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Loading transcript…
                </p>
              )}

              {!isLoading && turns.length === 0 && (
                <p className="text-[11px] italic text-gray-400">
                  The transcript could not be loaded.
                </p>
              )}

              {!isLoading && turns.length > 0 && (
                <ol className="space-y-2">
                  {turns.map((t, i) => (
                    <li key={i} className="text-[11px] leading-relaxed">
                      {t.speaker && (
                        <span
                          className={`mr-1.5 font-semibold uppercase tracking-wide text-[9px] ${
                            t.speaker === "agent"
                              ? "text-gray-400"
                              : "text-emerald-700"
                          }`}
                        >
                          {t.speaker === "agent" ? "AI" : "Dealer"}
                        </span>
                      )}
                      {/* The dealer's words carry the whole scoring decision, so
                          they get the readable weight and the agent's script
                          recedes. Reading a call to check a band is almost
                          entirely a search through this half. */}
                      <span
                        className={
                          t.speaker === "agent"
                            ? "text-gray-500"
                            : "text-gray-800"
                        }
                      >
                        {t.text}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
