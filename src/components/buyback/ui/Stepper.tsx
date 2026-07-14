import StatusChip from "@/components/buyback/StatusChip";
import { FLOW, FLOW_LABEL, stepIndexFor } from "@/lib/buyback/flow";

import Card from "./Card";

/**
 * Deal progress stepper — proto stepper() (iTarang Portal.dc.html:647-663),
 * driven by src/lib/buyback/flow.ts so the step math lives in exactly one
 * place. Terminal deals (REJECTED / CANCELLED) don't map onto the happy-path
 * FLOW at all — the prototype freezes them at step 1 and this does the same,
 * but greys the "done" segment (rather than the celebratory green) and adds
 * the real status as a chip so a terminated deal never reads as "still
 * progressing normally."
 */
export default function Stepper({ status }: { status: string }) {
  const idx = stepIndexFor(status);
  const terminal = idx === "terminal";
  const cur = terminal ? 1 : idx;

  return (
    <Card className="mb-2">
      <div className="overflow-x-auto p-[16px_18px]">
        <div className="flex min-w-[900px] items-center">
          {FLOW.map((step, i) => {
            const done = i < cur;
            const isCurrent = i === cur;
            const circleClass = done
              ? terminal
                ? "border-gray-300 bg-gray-300 text-white"
                : "border-green-600 bg-green-600 text-white"
              : isCurrent
                ? "border-bb-navy bg-bb-navy text-white"
                : "border-gray-200 bg-white text-slate-400";
            const labelClass = isCurrent
              ? "font-bold text-bb-navy"
              : done
                ? terminal
                  ? "text-slate-400"
                  : "text-green-600"
                : "text-slate-400";

            return (
              <div key={step} className={`flex items-center ${i < FLOW.length - 1 ? "flex-1" : "flex-none"}`}>
                <div className="flex flex-col items-center gap-[5px]">
                  <div
                    className={`flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 text-[11px] font-bold ${circleClass}`}
                  >
                    {done ? "✓" : i + 1}
                  </div>
                  <div className={`whitespace-nowrap text-[9.5px] ${labelClass}`}>{FLOW_LABEL[step]}</div>
                </div>
                {i < FLOW.length - 1 && (
                  <div className={`mx-1 mb-4 h-[2px] flex-1 ${done && !terminal ? "bg-green-600" : "bg-gray-200"}`} />
                )}
              </div>
            );
          })}
          {terminal && (
            <div className="ml-4 flex-none">
              <StatusChip status={status} />
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
