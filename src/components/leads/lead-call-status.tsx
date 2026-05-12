"use client";

import { CheckCircle2, PhoneCall } from "lucide-react";

export type CallRowStatus = "calling" | "ended" | "idle";

interface LeadCallStatusProps {
  status: CallRowStatus;
}

export function LeadCallStatus({ status }: LeadCallStatusProps) {
  if (status === "idle") return null;

  if (status === "calling") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75 animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        <PhoneCall className="w-3 h-3" />
        Calling…
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold bg-slate-100 text-slate-600 border border-slate-200">
      <CheckCircle2 className="w-3 h-3" />
      Call ended
    </span>
  );
}
