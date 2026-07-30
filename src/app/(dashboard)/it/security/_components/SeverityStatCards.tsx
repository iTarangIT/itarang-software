"use client";

import type { ComponentType } from "react";
import { ShieldAlert, ShieldX, ShieldQuestion, Shield, Info } from "lucide-react";
import { StatCard, type StatTone } from "@/components/ui/stat-card";
import { SEVERITIES, SEVERITY_LABELS, type Severity } from "@/lib/security/severity";

// Icons + tones live here (client side) — a lucide component is a function/object
// with methods and cannot be passed as a prop from a Server Component.
const TONE: Record<Severity, StatTone> = {
  critical: "danger",
  high: "danger",
  medium: "warning",
  low: "sky",
  info: "neutral",
};
const ICON: Record<Severity, ComponentType<{ className?: string }>> = {
  critical: ShieldX,
  high: ShieldAlert,
  medium: ShieldQuestion,
  low: Shield,
  info: Info,
};

export default function SeverityStatCards({ counts }: { counts: Record<Severity, number> }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      {SEVERITIES.map((s, i) => (
        <StatCard
          key={s}
          label={SEVERITY_LABELS[s]}
          value={counts[s]}
          tone={TONE[s]}
          icon={ICON[s]}
          index={i}
        />
      ))}
    </div>
  );
}
