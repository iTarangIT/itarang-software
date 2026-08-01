"use client";

import { ShieldX, ShieldAlert, Ban, Activity } from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";

export interface LiveCounts {
  critical: number;
  high: number;
  blocked: number;
  total: number;
}

/** 24-hour intrusion-detection KPIs. Icons live here (client) — a Server
 *  Component can't pass a lucide component across the boundary. */
export default function LiveStatCards({ counts }: { counts: LiveCounts }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <StatCard label="Critical (24h)" value={counts.critical} tone="danger" icon={ShieldX} index={0} />
      <StatCard label="High (24h)" value={counts.high} tone="warning" icon={ShieldAlert} index={1} />
      <StatCard label="Blocked (24h)" value={counts.blocked} tone="sky" icon={Ban} index={2} />
      <StatCard label="Total events (24h)" value={counts.total} tone="neutral" icon={Activity} index={3} />
    </div>
  );
}
