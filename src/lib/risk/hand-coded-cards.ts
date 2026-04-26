/**
 * Five hand-coded hypothesis evaluators that run before the LangGraph workflow
 * is wired. Each one returns a card "evaluation" — severity + finding +
 * affected_count + evidence — that the Risk page can render directly and that
 * we persist into risk_card_runs so the UI shape matches LLM-produced cards.
 *
 * Each function takes the tenant's loan slice (from CRM) and the IoT helpers
 * and returns a CardEvaluation. They're intentionally simple — the goal is to
 * prove the data path end-to-end before letting the agent generate hypotheses.
 */
import {
  getDailyKm,
  getSohDelta30d,
  getVehicleStates,
  type VehicleStateRow,
} from "@/lib/db/iot-queries";

export type Severity = "high" | "warn" | "ok";

export interface TenantLoanSlice {
  loan_application_id: string;
  vehicleno: string | null;
  current_dpd: number;
  emi_amount: number | null;
  outstanding_amount: number | null;
}

export interface CardEvaluation {
  slug: string;
  severity: Severity;
  finding_summary: string;
  affected_count: number;
  total_count: number;
  evidence: {
    sample_rows?: Array<Record<string, unknown>>;
    chart?: { kind: string; data: unknown };
    notes?: string[];
  };
}

// Map slug → evaluator. Add new hand-coded ones here.
export const HAND_CODED_CARDS: Record<string, (loans: TenantLoanSlice[]) => Promise<CardEvaluation>> = {
  "usage-drop-7d": evalUsageDrop7d,
  "dpd-7-no-telemetry": evalDpd7NoTelemetry,
  "geo-shift": evalGeoShift,
  "battery-soh-decay": evalBatterySohDecay,
  "low-utilization-active-loan": evalLowUtilizationActiveLoan,
};

// ─── helpers ────────────────────────────────────────────────────────────────

function vnos(loans: TenantLoanSlice[]): string[] {
  return loans
    .map((l) => l.vehicleno)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

function pickSeverity(affectedFraction: number, highCutoff = 0.05, warnCutoff = 0.01): Severity {
  if (affectedFraction >= highCutoff) return "high";
  if (affectedFraction >= warnCutoff) return "warn";
  return "ok";
}

// ─── 1. 7-day usage cliff ───────────────────────────────────────────────────

async function evalUsageDrop7d(loans: TenantLoanSlice[]): Promise<CardEvaluation> {
  const vehiclenos = vnos(loans);
  const total = loans.length;
  const daily = await getDailyKm(vehiclenos, 14);
  // Bucket per vehicle into last-7d total vs prior-7d total.
  const now = Date.now();
  const sevenAgo = now - 7 * 86400_000;
  const fourteenAgo = now - 14 * 86400_000;
  const buckets = new Map<string, { recent: number; prior: number }>();
  for (const r of daily) {
    const t = r.day.getTime();
    const slot = buckets.get(r.vehicleno) ?? { recent: 0, prior: 0 };
    if (t >= sevenAgo) slot.recent += r.km;
    else if (t >= fourteenAgo) slot.prior += r.km;
    buckets.set(r.vehicleno, slot);
  }
  const droppers: Array<{ vehicleno: string; prior: number; recent: number; drop_pct: number }> = [];
  for (const [vno, b] of buckets) {
    if (b.prior < 50) continue; // ignore vehicles with negligible baseline
    const dropPct = (b.prior - b.recent) / b.prior;
    if (dropPct >= 0.4) {
      droppers.push({ vehicleno: vno, prior: b.prior, recent: b.recent, drop_pct: dropPct });
    }
  }
  droppers.sort((a, b) => b.drop_pct - a.drop_pct);
  const affected = droppers.length;
  const severity = pickSeverity(affected / Math.max(total, 1));
  return {
    slug: "usage-drop-7d",
    severity,
    finding_summary:
      affected === 0
        ? "No borrowers showed a ≥40% week-over-week km drop."
        : `${affected} borrowers had ≥40% drop in 7-day km vs prior 7 days.`,
    affected_count: affected,
    total_count: total,
    evidence: {
      sample_rows: droppers.slice(0, 10),
      chart: { kind: "bar", data: droppers.slice(0, 10).map((d) => ({ x: d.vehicleno, y: d.drop_pct })) },
      notes: [
        "Excludes vehicles with <50 km in prior 7d (avoids noise on idle units).",
        `Threshold: 40% drop (matches default usage-drop in risk-thresholds.ts).`,
      ],
    },
  };
}

// ─── 2. Past-due + telemetry silent ─────────────────────────────────────────

async function evalDpd7NoTelemetry(loans: TenantLoanSlice[]): Promise<CardEvaluation> {
  const overdue = loans.filter((l) => l.current_dpd >= 7);
  const vehiclenos = vnos(overdue);
  const states = await getVehicleStates(vehiclenos);
  const stateByVno = new Map(states.map((s) => [s.vehicleno, s]));
  const concerning: Array<Record<string, unknown>> = [];
  for (const loan of overdue) {
    if (!loan.vehicleno) continue;
    const s = stateByVno.get(loan.vehicleno);
    const stale = !s || s.sec_since_gps == null || s.sec_since_gps > 6 * 3600;
    if (stale) {
      concerning.push({ ...loan, sec_since_gps: s?.sec_since_gps ?? null });
    }
  }
  const severity = pickSeverity(concerning.length / Math.max(loans.length, 1), 0.03, 0.01);
  return {
    slug: "dpd-7-no-telemetry",
    severity,
    finding_summary:
      concerning.length === 0
        ? "No 7+ DPD borrowers are currently telemetry-silent."
        : `${concerning.length} borrowers are 7+ DPD and have not reported GPS for 6h+.`,
    affected_count: concerning.length,
    total_count: overdue.length,
    evidence: {
      sample_rows: concerning.slice(0, 10),
      notes: [
        `Pool: ${overdue.length} loans currently 7+ DPD.`,
        "GPS-silence threshold: 6 hours (operator-tunable in audit page later).",
      ],
    },
  };
}

// ─── 3. Vehicle outside operating radius (geo-shift) ────────────────────────
// MVP: we don't yet have onboarding-region centroids. For now: vehicles whose
// CURRENT lat/lon falls outside India's bounding box are flagged. Phase B will
// replace this with a real per-borrower centroid stored at onboarding time.

async function evalGeoShift(loans: TenantLoanSlice[]): Promise<CardEvaluation> {
  const vehiclenos = vnos(loans);
  const states = await getVehicleStates(vehiclenos);
  // India bbox: lat 6-37, lon 68-97 (rough)
  const outside: VehicleStateRow[] = states.filter(
    (s) =>
      s.lat != null &&
      s.lon != null &&
      (s.lat < 6 || s.lat > 37 || s.lon < 68 || s.lon > 97),
  );
  const severity = pickSeverity(outside.length / Math.max(loans.length, 1), 0.005, 0.001);
  return {
    slug: "geo-shift",
    severity,
    finding_summary:
      outside.length === 0
        ? "All vehicles with GPS fix are within India bbox."
        : `${outside.length} vehicles report a location outside expected operating geography.`,
    affected_count: outside.length,
    total_count: loans.length,
    evidence: {
      sample_rows: outside.slice(0, 10).map((s) => ({
        vehicleno: s.vehicleno,
        lat: s.lat,
        lon: s.lon,
      })),
      notes: [
        "Phase A heuristic: India bounding box. Phase B: per-borrower onboarding centroid + 100km radius.",
      ],
    },
  };
}

// ─── 4. Accelerated battery degradation ─────────────────────────────────────

async function evalBatterySohDecay(loans: TenantLoanSlice[]): Promise<CardEvaluation> {
  const vehiclenos = vnos(loans);
  const decay = await getSohDelta30d(vehiclenos);
  const concerning = decay.filter((d) => d.delta <= -5); // 5pp drop or more (delta is signed)
  concerning.sort((a, b) => a.delta - b.delta);
  const severity = pickSeverity(concerning.length / Math.max(loans.length, 1), 0.02, 0.005);
  return {
    slug: "battery-soh-decay",
    severity,
    finding_summary:
      concerning.length === 0
        ? "No vehicles show >5pp SOH drop in last 30 days."
        : `${concerning.length} vehicles show >5pp SOH drop in the last 30 days.`,
    affected_count: concerning.length,
    total_count: decay.length,
    evidence: {
      sample_rows: concerning.slice(0, 10),
      notes: [
        `SOH baseline = oldest reading in last 30d. Current = newest reading.`,
        `Sample size: only ${decay.length} of ${loans.length} loans had readings on both ends.`,
      ],
    },
  };
}

// ─── 5. Active loan, low utilization ────────────────────────────────────────

async function evalLowUtilizationActiveLoan(loans: TenantLoanSlice[]): Promise<CardEvaluation> {
  const activeWithEmi = loans.filter((l) => l.emi_amount && Number(l.emi_amount) > 0);
  const vehiclenos = vnos(activeWithEmi);
  const daily = await getDailyKm(vehiclenos, 14);
  const totalsByVno = new Map<string, number>();
  for (const r of daily) totalsByVno.set(r.vehicleno, (totalsByVno.get(r.vehicleno) ?? 0) + r.km);
  const concerning: Array<{
    vehicleno: string;
    avg_km_per_day: number;
    emi_amount: number | null;
  }> = [];
  for (const loan of activeWithEmi) {
    if (!loan.vehicleno) continue;
    const total = totalsByVno.get(loan.vehicleno) ?? 0;
    const avgPerDay = total / 14;
    if (avgPerDay < 20) {
      concerning.push({
        vehicleno: loan.vehicleno,
        avg_km_per_day: avgPerDay,
        emi_amount: loan.emi_amount,
      });
    }
  }
  concerning.sort((a, b) => a.avg_km_per_day - b.avg_km_per_day);
  const severity = pickSeverity(concerning.length / Math.max(activeWithEmi.length, 1), 0.1, 0.04);
  return {
    slug: "low-utilization-active-loan",
    severity,
    finding_summary:
      concerning.length === 0
        ? "No active-loan vehicles below 20 km/day average."
        : `${concerning.length} vehicles with active EMI averaged <20 km/day in the last 14 days.`,
    affected_count: concerning.length,
    total_count: activeWithEmi.length,
    evidence: {
      sample_rows: concerning.slice(0, 10),
      notes: [
        "Threshold: <20 km/day average over 14 days.",
        "Phase B: tier this by region (rural vs urban have different utilisation norms).",
      ],
    },
  };
}
