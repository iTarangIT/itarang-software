// Cost-component breakdown — answers "where did the money go?". Renders
// as a single segmented horizontal bar (proportions read instantly) with
// a small legend table underneath showing absolute INR + share.
//
// LLM / TTS / STT / Telephony / Platform map to fixed colors so the same
// segment color is consistent here, in the per-call drawer, and in CSV
// exports (where finance has external chart tooling).

"use client";

import { Layers } from "lucide-react";
import { formatINR } from "@/lib/currency";
import type { ComponentBreakdown } from "./types";

type Segment = {
  key: keyof ComponentBreakdown;
  label: string;
  color: string;
  swatch: string;
};

const SEGMENTS: Segment[] = [
  { key: "llm", label: "LLM", color: "#0d9488", swatch: "bg-teal-600" },
  { key: "tts", label: "Text-to-Speech", color: "#6366f1", swatch: "bg-indigo-500" },
  { key: "stt", label: "Speech-to-Text", color: "#f59e0b", swatch: "bg-amber-500" },
  { key: "telephony", label: "Telephony", color: "#3b82f6", swatch: "bg-blue-500" },
  { key: "platform", label: "Platform", color: "#a855f7", swatch: "bg-purple-500" },
];

type ComponentBreakdownChartProps = {
  data: ComponentBreakdown;
  loading?: boolean;
};

export function ComponentBreakdownChart({
  data,
  loading,
}: ComponentBreakdownChartProps) {
  const total =
    data.llm + data.tts + data.stt + data.telephony + data.platform;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-6">
      <div className="flex items-center gap-2 mb-1">
        <Layers className="w-3.5 h-3.5 text-gray-400" />
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500">
          Cost components
        </span>
      </div>
      <h3 className="text-base font-bold text-gray-900 tracking-tight mb-5">
        Where the money goes
      </h3>

      {loading || total === 0 ? (
        <div className="h-3 rounded-full bg-gray-100" />
      ) : (
        <div className="flex h-3 rounded-full overflow-hidden">
          {SEGMENTS.map((seg) => {
            const cents = data[seg.key];
            const pct = total > 0 ? (cents / total) * 100 : 0;
            if (pct <= 0) return null;
            return (
              <div
                key={seg.key}
                style={{ width: `${pct}%`, backgroundColor: seg.color }}
                className="h-full first:rounded-l-full last:rounded-r-full transition-all"
                title={`${seg.label} ${pct.toFixed(1)}%`}
              />
            );
          })}
        </div>
      )}

      <ul className="mt-5 space-y-2.5">
        {SEGMENTS.map((seg) => {
          const cents = data[seg.key];
          const pct = total > 0 ? (cents / total) * 100 : 0;
          return (
            <li
              key={seg.key}
              className="flex items-center justify-between text-sm"
            >
              <div className="flex items-center gap-2.5">
                <span className={`w-2.5 h-2.5 rounded-full ${seg.swatch}`} />
                <span className="text-gray-700">{seg.label}</span>
              </div>
              <div className="flex items-center gap-3 tabular-nums">
                <span className="text-[11px] text-gray-400 w-12 text-right">
                  {pct.toFixed(1)}%
                </span>
                <span className="font-semibold text-gray-900 w-20 text-right">
                  {formatINR(cents)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      {total > 0 && (
        <div className="mt-4 pt-3 border-t border-gray-100 flex items-center justify-between text-sm">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500">
            Total
          </span>
          <span className="font-bold text-gray-900 tabular-nums">
            {formatINR(total)}
          </span>
        </div>
      )}

      <p className="mt-3 text-[10px] text-gray-400">
        Bolna ships all five components; ElevenLabs bundles TTS/STT into
        telephony — empty segments are normal when filtered to one provider.
      </p>
    </div>
  );
}
