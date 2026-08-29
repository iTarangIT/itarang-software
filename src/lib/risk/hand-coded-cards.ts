/**
 * Six hand-coded hypothesis evaluators that run before the LangGraph workflow
 * is wired. Each one returns a card "evaluation" — severity + finding +
 * affected_count + evidence — that the Risk page can render directly and that
 * we persist into risk_card_runs so the UI shape matches LLM-produced cards.
 *
 * Each function takes the tenant's loan slice (from CRM) and the IoT helpers
 * and returns a CardEvaluation. They're intentionally simple — the goal is to
 * prove the data path end-to-end before letting the agent generate hypotheses.
 */
import {
  GEO_SHIFT_MIN_HOME_POINTS,
  getDailyKm,
  getGeoShiftDistances,
  getSohDelta30d,
  getVehicleStates,
} from "@/lib/db/iot-queries";
import type { Severity, VerdictSource } from "@/lib/risk/severity";
import type { RiskThresholds } from "@/lib/nbfc/risk-thresholds";
import { cityCentroid, haversineKm } from "@/lib/geo/city-centroid";


export type { Severity, VerdictSource } from "@/lib/risk/severity";

export interface TenantLoanSlice {
  loan_application_id: string;
  vehicleno: string | null;
  current_dpd: number;
  emi_amount: number | null;
  outstanding_amount: number | null;
  /**
   * E-274 — the city this loan is assigned to: the borrower's, else the
   * selling dealer's. See getTenantLoanSlice(). Optional so a hand-built slice
   * (scripts, tests) that predates the field still satisfies every evaluator.
   */
  assigned_city?: string | null;
  assigned_state?: string | null;
  assigned_city_source?: "borrower" | "dealer" | null;
}

export interface CardEvaluation {
  slug: string;
  severity: Severity;
  /** Who computed the numbers. Every evaluator in this file is `hand_coded`. */
  verdict_source: VerdictSource;
  finding_summary: string;
  affected_count: number;
  total_count: number;
  evidence: {
    sample_rows?: Array<Record<string, unknown>>;
    chart?: { kind: string; data: unknown };
    notes?: string[];
    /**
     * The governed thresholds this card was actually judged by, snapshotted at
     * run time. Without this, a card read six months from now is silently
     * reinterpreted against whatever the rules say then.
     */
    thresholds?: Record<string, number>;
  };
}

export type CardEvaluator = (
  loans: TenantLoanSlice[],
  thresholds: RiskThresholds,
) => Promise<CardEvaluation>;

// Map slug → evaluator. Add new hand-coded ones here.
export const HAND_CODED_CARDS: Record<string, CardEvaluator> = {
  "usage-drop-7d": evalUsageDrop7d,
  "dpd-7-no-telemetry": evalDpd7NoTelemetry,
  "geo-shift": evalGeoShift,
  "battery-soh-decay": evalBatterySohDecay,
  "low-utilization-active-loan": evalLowUtilizationActiveLoan,
  "outside-assigned-city": evalOutsideAssignedCity,
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

/**
 * The card for a test whose assessable population turned out to be empty.
 *
 * This is the difference between "we checked 5 vehicles and all 5 are fine" and
 * "no vehicle had enough telemetry to check". Both used to come out of
 * pickSeverity(0 / max(0,1)) as a green OK showing `0 / 0 affected`, so a total
 * absence of data rendered identically to a clean bill of health. It is a
 * coverage gap, not a finding, and it says so.
 */
function notAssessable(slug: string, why: string, notes: string[] = []): CardEvaluation {
  return {
    slug,
    severity: "inconclusive",
    verdict_source: "none",
    finding_summary: why,
    affected_count: 0,
    total_count: 0,
    evidence: { notes: [why, ...notes] },
  };
}

// ─── 1. 7-day usage cliff ───────────────────────────────────────────────────

async function evalUsageDrop7d(
  loans: TenantLoanSlice[],
  thresholds: RiskThresholds,
): Promise<CardEvaluation> {
  // Governed: usage_drop_pct (BRD default 40%). Was hard-coded to 0.4 here,
  // which meant the admin Risk Rule screen had no effect on this card.
  const dropCutoff = thresholds.usage_drop_pct / 100;
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
  // Vehicles with a real prior-week baseline — the only ones a week-over-week
  // drop can be measured on. Everything else is excluded from the denominator
  // rather than counted as "no drop".
  let withBaseline = 0;
  for (const [vno, b] of buckets) {
    if (b.prior < 50) continue; // ignore vehicles with negligible baseline
    withBaseline += 1;
    const dropPct = (b.prior - b.recent) / b.prior;
    if (dropPct >= dropCutoff) {
      droppers.push({ vehicleno: vno, prior: b.prior, recent: b.recent, drop_pct: dropPct });
    }
  }

  const pct = thresholds.usage_drop_pct;
  if (withBaseline === 0) {
    return notAssessable(
      "usage-drop-7d",
      `Not assessable — none of the ${total} loans have a vehicle with at least 50 km of prior-week mileage to compare against.`,
      ["A week-over-week drop needs a baseline week; with no baseline there is nothing to drop from."],
    );
  }

  droppers.sort((a, b) => b.drop_pct - a.drop_pct);
  const affected = droppers.length;
  const severity = pickSeverity(affected / Math.max(withBaseline, 1));
  return {
    slug: "usage-drop-7d",
    severity,
    verdict_source: "hand_coded",
    finding_summary:
      affected === 0
        ? `No borrowers showed a ≥${pct}% week-over-week km drop (${withBaseline} assessed).`
        : `${affected} of ${withBaseline} assessed borrowers had a ≥${pct}% drop in 7-day km vs the prior 7 days.`,
    affected_count: affected,
    // The assessed population, not the whole book — the share shown on the card
    // is now the same share that picked its colour.
    total_count: withBaseline,
    evidence: {
      sample_rows: droppers.slice(0, 10),
      chart: { kind: "bar", data: droppers.slice(0, 10).map((d) => ({ x: d.vehicleno, y: d.drop_pct })) },
      notes: [
        `${withBaseline} of ${total} loans had a vehicle with a usable prior-week baseline (≥50 km); the rest are excluded as unmeasurable, not counted as healthy.`,
        `Threshold: ${pct}% drop, from the governed usage_drop_pct rule.`,
      ],
      thresholds: { usage_drop_pct: pct },
    },
  };
}

// ─── 2. Past-due + telemetry silent ─────────────────────────────────────────

async function evalDpd7NoTelemetry(
  loans: TenantLoanSlice[],
  thresholds: RiskThresholds,
): Promise<CardEvaluation> {
  // Governed: emi_overdue_days (default 30) and offline_alert_hours (default 24).
  // Both were hard-coded — 7 days and 6 hours respectively — so this card tested
  // something neither the BRD nor the admin screen had ever agreed to.
  const dpdCutoff = thresholds.emi_overdue_days;
  const silenceSeconds = thresholds.offline_alert_hours * 3600;

  const overdue = loans.filter((l) => l.current_dpd >= dpdCutoff);
  const vehiclenos = vnos(overdue);
  const states = await getVehicleStates(vehiclenos);
  const stateByVno = new Map(states.map((s) => [s.vehicleno, s]));
  const concerning: Array<Record<string, unknown>> = [];
  for (const loan of overdue) {
    if (!loan.vehicleno) continue;
    const s = stateByVno.get(loan.vehicleno);
    const stale = !s || s.sec_since_gps == null || s.sec_since_gps > silenceSeconds;
    if (stale) {
      concerning.push({ ...loan, sec_since_gps: s?.sec_since_gps ?? null });
    }
  }

  // Denominator is the overdue pool — the population this hypothesis is about.
  // It used to score `concerning / all loans` while *displaying* `/ overdue`, so
  // the share the operator read off the card was not the share that picked the
  // colour.
  const severity = pickSeverity(concerning.length / Math.max(overdue.length, 1), 0.03, 0.01);
  return {
    slug: "dpd-7-no-telemetry",
    severity,
    verdict_source: "hand_coded",
    finding_summary:
      overdue.length === 0
        ? `No borrowers are currently ${dpdCutoff}+ days past due.`
        : concerning.length === 0
          ? `No ${dpdCutoff}+ DPD borrowers are currently telemetry-silent.`
          : `${concerning.length} of ${overdue.length} borrowers are ${dpdCutoff}+ DPD and have not reported GPS for ${thresholds.offline_alert_hours}h+.`,
    affected_count: concerning.length,
    total_count: overdue.length,
    evidence: {
      sample_rows: concerning.slice(0, 10),
      notes: [
        `Pool: ${overdue.length} of ${loans.length} loans are currently ${dpdCutoff}+ DPD (governed emi_overdue_days rule).`,
        `GPS-silence threshold: ${thresholds.offline_alert_hours} hours (governed offline_alert_hours rule).`,
      ],
      thresholds: {
        emi_overdue_days: dpdCutoff,
        offline_alert_hours: thresholds.offline_alert_hours,
      },
    },
  };
}

// ─── 3. Vehicle outside operating radius (geo-shift) ────────────────────────
// Was: "is the vehicle's current position outside a bounding box of India?" —
// which flagged asset diversion only if an e-rickshaw left the country, while
// the card told operators it was checking distance from an onboarding centroid.
// Now: distance from the vehicle's own 30-day home cluster, against the governed
// geo_shift_km rule. See getGeoShiftDistances().

const GEO_HOME_WINDOW_DAYS = 30;

async function evalGeoShift(
  loans: TenantLoanSlice[],
  thresholds: RiskThresholds,
): Promise<CardEvaluation> {
  const limitKm = thresholds.geo_shift_km;
  const vehiclenos = vnos(loans);
  const rows = await getGeoShiftDistances(vehiclenos, GEO_HOME_WINDOW_DAYS);

  // A vehicle with too few fixes in its modal cell has no established home base.
  // Measuring "distance from home" for it would be measuring distance from noise,
  // so it is excluded from the denominator rather than scored.
  const assessable = rows.filter((r) => r.home_points >= GEO_SHIFT_MIN_HOME_POINTS);
  const unassessable = loans.length - assessable.length;

  if (assessable.length === 0) {
    return notAssessable(
      "geo-shift",
      `Not assessable — none of the ${loans.length} vehicles have enough GPS history in the last ${GEO_HOME_WINDOW_DAYS} days to establish a home base.`,
      [`A home base needs at least ${GEO_SHIFT_MIN_HOME_POINTS} GPS fixes in its most-visited area.`],
    );
  }

  const outside = assessable
    .filter((r) => r.distance_km > limitKm)
    .sort((a, b) => b.distance_km - a.distance_km);

  const severity = pickSeverity(
    outside.length / Math.max(assessable.length, 1),
    0.005,
    0.001,
  );

  return {
    slug: "geo-shift",
    severity,
    verdict_source: "hand_coded",
    finding_summary:
      assessable.length === 0
        ? `Geo-shift not assessable — none of the ${loans.length} vehicles have enough GPS history in the last ${GEO_HOME_WINDOW_DAYS} days to establish a home base.`
        : outside.length === 0
          ? `No vehicles are more than ${limitKm} km from their usual operating area (${assessable.length} assessed).`
          : `${outside.length} of ${assessable.length} vehicles are more than ${limitKm} km from their usual operating area.`,
    affected_count: outside.length,
    total_count: assessable.length,
    evidence: {
      sample_rows: outside.slice(0, 10).map((r) => ({
        vehicleno: r.vehicleno,
        distance_km: Math.round(r.distance_km),
        current_lat: r.current_lat,
        current_lon: r.current_lon,
        home_lat: r.home_lat,
        home_lon: r.home_lon,
      })),
      notes: [
        `Threshold: more than ${limitKm} km from home (governed geo_shift_km rule).`,
        `Home base = the most-visited ~11 km GPS cell over the last ${GEO_HOME_WINDOW_DAYS} days, needing at least ${GEO_SHIFT_MIN_HOME_POINTS} fixes to count.`,
        ...(unassessable > 0
          ? [
              `${unassessable} of ${loans.length} vehicles had no establishable home base (too few GPS fixes) and were excluded — a coverage gap, not a clean result.`,
            ]
          : []),
      ],
      thresholds: { geo_shift_km: limitKm },
    },
  };
}

// ─── 4. Accelerated battery degradation ─────────────────────────────────────

/**
 * Percentage points of SOH loss over 30 days that counts as accelerated decay.
 * Deliberately NOT a governed rule: the eight `nbfc_risk_rules` keys have no
 * battery-degradation entry, so there is nothing in the admin screen to read.
 * Hard-coded and labelled as such, rather than silently pretending to be tunable.
 */
const SOH_DECAY_PP_30D = 5;

async function evalBatterySohDecay(loans: TenantLoanSlice[]): Promise<CardEvaluation> {
  const vehiclenos = vnos(loans);
  const decay = await getSohDelta30d(vehiclenos);

  if (decay.length === 0) {
    return notAssessable(
      "battery-soh-decay",
      `Not assessable — none of the ${loans.length} loans have an SOH reading at both ends of the 30-day window.`,
      ["Measuring decay needs a baseline and a current reading; with neither there is nothing to compare."],
    );
  }

  const concerning = decay.filter((d) => d.delta <= -SOH_DECAY_PP_30D); // delta is signed
  concerning.sort((a, b) => a.delta - b.delta);

  // Denominator is the measured population — vehicles with an SOH reading at
  // both ends of the window. Scoring against every loan (most of which have no
  // reading) diluted the fraction and under-reported the severity, while the
  // card displayed the measured count as its total.
  const severity = pickSeverity(concerning.length / Math.max(decay.length, 1), 0.02, 0.005);
  return {
    slug: "battery-soh-decay",
    severity,
    verdict_source: "hand_coded",
    finding_summary:
      decay.length === 0
        ? `Battery decay not assessable — none of the ${loans.length} loans have SOH readings at both ends of the 30-day window.`
        : concerning.length === 0
          ? `No vehicles show >${SOH_DECAY_PP_30D}pp SOH drop in the last 30 days (${decay.length} assessed).`
          : `${concerning.length} of ${decay.length} assessed vehicles show >${SOH_DECAY_PP_30D}pp SOH drop in the last 30 days.`,
    affected_count: concerning.length,
    total_count: decay.length,
    evidence: {
      sample_rows: concerning.slice(0, 10),
      notes: [
        `SOH baseline = oldest reading in last 30d. Current = newest reading.`,
        `Only ${decay.length} of ${loans.length} loans had readings on both ends; the rest are excluded as unmeasurable.`,
        `Threshold: ${SOH_DECAY_PP_30D}pp — hard-coded, as there is no battery-degradation rule in the risk-rule catalogue.`,
      ],
    },
  };
}

// ─── 5. Active loan, low utilization ────────────────────────────────────────

const UTILISATION_WINDOW_DAYS = 14;
/**
 * Km/day below which an active-EMI vehicle counts as under-utilised. Like the
 * SOH threshold, this has no entry in the eight-rule catalogue, so it stays a
 * documented constant rather than a fake-configurable one.
 */
const LOW_UTILISATION_KM_PER_DAY = 20;
/**
 * Reporting days a vehicle needs inside the window before its average is a
 * measurement rather than a guess. Below this we exclude it instead of scoring
 * it — an unmeasurable vehicle is a coverage problem, not a credit signal.
 */
const MIN_ASSESSABLE_DAYS = 7;

async function evalLowUtilizationActiveLoan(loans: TenantLoanSlice[]): Promise<CardEvaluation> {
  const activeWithEmi = loans.filter((l) => l.emi_amount && Number(l.emi_amount) > 0);
  const vehiclenos = vnos(activeWithEmi);
  const daily = await getDailyKm(vehiclenos, UTILISATION_WINDOW_DAYS);

  // Average over the days a vehicle ACTUALLY reported — never over a fixed 14.
  // distance_rollup emits a row (often ~0.01 km) for a parked-but-powered
  // vehicle, so a genuinely idle day still lands in the denominator and a truly
  // idle vehicle still trips the threshold. A MISSING day means the pipeline had
  // no contact at all; treating those as zero-km days is what let a 10-day
  // ingestion outage deflate every vehicle's average by 3.5x and fire a false
  // "2 of 5 under 20 km/day" High Alert while the fleet was doing 50-93 km/day.
  const statsByVno = new Map<string, { km: number; days: number }>();
  for (const r of daily) {
    const s = statsByVno.get(r.vehicleno) ?? { km: 0, days: 0 };
    s.km += r.km;
    s.days += 1; // getDailyKm returns exactly one row per (vehicle, day) bucket
    statsByVno.set(r.vehicleno, s);
  }

  const concerning: Array<{
    vehicleno: string;
    avg_km_per_day: number;
    days_reported: number;
    emi_amount: number | null;
  }> = [];
  const noTelemetry: string[] = [];
  const thinCoverage: Array<{ vehicleno: string; days_reported: number }> = [];

  for (const loan of activeWithEmi) {
    if (!loan.vehicleno) continue;
    const s = statsByVno.get(loan.vehicleno);
    // No row at all in the window → no telemetry contact, not a measurement.
    if (!s || s.days === 0) {
      noTelemetry.push(loan.vehicleno);
      continue;
    }
    // Some rows, but too few days to average over honestly.
    if (s.days < MIN_ASSESSABLE_DAYS) {
      thinCoverage.push({ vehicleno: loan.vehicleno, days_reported: s.days });
      continue;
    }
    const avgPerDay = s.km / s.days;
    if (avgPerDay < LOW_UTILISATION_KM_PER_DAY) {
      concerning.push({
        vehicleno: loan.vehicleno,
        avg_km_per_day: avgPerDay,
        days_reported: s.days,
        emi_amount: loan.emi_amount,
      });
    }
  }
  concerning.sort((a, b) => a.avg_km_per_day - b.avg_km_per_day);

  // Denominator is the ASSESSABLE population — vehicles with enough reporting
  // days to have a real average. Vehicles with no telemetry, or too thin a
  // window to judge, are excluded and surfaced as coverage notes rather than
  // scored as idle.
  const observable = activeWithEmi.length - noTelemetry.length - thinCoverage.length;

  if (observable === 0) {
    return notAssessable(
      "low-utilization-active-loan",
      `Not assessable — none of the ${activeWithEmi.length} active-EMI vehicles reported on at least ${MIN_ASSESSABLE_DAYS} of the last ${UTILISATION_WINDOW_DAYS} days.`,
      [
        `${noTelemetry.length} had no telemetry at all; ${thinCoverage.length} reported on too few days to average honestly.`,
        "A fleet-wide shortfall here means the telemetry pipeline has a gap, not that borrowers stopped driving.",
      ],
    );
  }

  const severity = pickSeverity(concerning.length / Math.max(observable, 1), 0.1, 0.04);

  const noTelemetryNote =
    noTelemetry.length > 0
      ? `${noTelemetry.length} of ${activeWithEmi.length} active-EMI vehicles had NO telemetry in the last ${UTILISATION_WINDOW_DAYS} days — excluded (see "Past-due + telemetry silent" for the coverage signal).`
      : null;
  const thinCoverageNote =
    thinCoverage.length > 0
      ? `${thinCoverage.length} of ${activeWithEmi.length} active-EMI vehicles reported on fewer than ${MIN_ASSESSABLE_DAYS} of the last ${UTILISATION_WINDOW_DAYS} days (${thinCoverage
          .slice(0, 10)
          .map((t) => `${t.vehicleno}: ${t.days_reported}d`)
          .join(
            ", ",
          )}) — excluded as unmeasurable. A fleet-wide shortfall here means the telemetry pipeline has a gap, not that borrowers stopped driving.`
      : null;

  return {
    slug: "low-utilization-active-loan",
    severity,
    verdict_source: "hand_coded",
    finding_summary:
      observable === 0
        ? `Utilisation not assessable — none of the ${activeWithEmi.length} active-EMI vehicles reported on at least ${MIN_ASSESSABLE_DAYS} of the last ${UTILISATION_WINDOW_DAYS} days.`
        : concerning.length === 0
          ? `No assessable active-loan vehicles below ${LOW_UTILISATION_KM_PER_DAY} km/day (${observable} assessed).`
          : `${concerning.length} of ${observable} assessable vehicles averaged <${LOW_UTILISATION_KM_PER_DAY} km/day across the days they reported.`,
    affected_count: concerning.length,
    total_count: observable,
    evidence: {
      sample_rows: concerning.slice(0, 10),
      notes: [
        `Threshold: <${LOW_UTILISATION_KM_PER_DAY} km/day, averaged over the days each vehicle actually reported inside a ${UTILISATION_WINDOW_DAYS}-day window.`,
        `Vehicles with fewer than ${MIN_ASSESSABLE_DAYS} reporting days are excluded — a missing day is a pipeline gap, not a zero-km day.`,
        ...(noTelemetryNote ? [noTelemetryNote] : []),
        ...(thinCoverageNote ? [thinCoverageNote] : []),
        "Phase B: tier this by region (rural vs urban have different utilisation norms).",
      ],
    },
  };
}

// ─── 6. Vehicle outside its assigned city (E-274) ───────────────────────────
// Different question from geo-shift. Geo-shift asks "is the vehicle far from
// wherever it USUALLY is" — a learned home base, which quietly follows a
// diverted asset to its new home after 30 days. This asks "is the vehicle
// outside the city the loan was WRITTEN for" — a fixed point the NBFC agreed to
// at sanction, which does not move when the vehicle does.

/**
 * How stale a GPS fix may be and still count as "where the vehicle is". A fix
 * older than the governed offline_alert_hours is the silence card's business
 * (dpd-7-no-telemetry), not a position — measuring distance from it would
 * report where the vehicle WAS as where it IS.
 */
async function evalOutsideAssignedCity(
  loans: TenantLoanSlice[],
  thresholds: RiskThresholds,
): Promise<CardEvaluation> {
  const radiusKm = thresholds.city_geofence_km;
  const freshSeconds = thresholds.offline_alert_hours * 3600;
  const slug = "outside-assigned-city";

  // Coverage, counted so the card can say why each loan was or was not judged.
  let noCity = 0;
  let unknownCity = 0;
  let noVehicle = 0;
  let noFix = 0;
  let staleFix = 0;

  type Candidate = {
    loan: TenantLoanSlice;
    centre: { lat: number; lng: number };
  };
  const candidates: Candidate[] = [];
  for (const loan of loans) {
    if (!loan.assigned_city) {
      noCity += 1;
      continue;
    }
    const centre = cityCentroid(loan.assigned_city);
    if (!centre) {
      unknownCity += 1;
      continue;
    }
    if (!loan.vehicleno) {
      noVehicle += 1;
      continue;
    }
    candidates.push({ loan, centre });
  }

  const states = await getVehicleStates(candidates.map((c) => c.loan.vehicleno as string));
  const stateByVno = new Map(states.map((s) => [s.vehicleno, s]));

  const assessed: Array<Record<string, unknown> & { distance_km: number }> = [];
  for (const { loan, centre } of candidates) {
    const s = stateByVno.get(loan.vehicleno as string);
    if (!s || s.lat == null || s.lon == null) {
      noFix += 1;
      continue;
    }
    if (s.sec_since_gps == null || s.sec_since_gps > freshSeconds) {
      staleFix += 1;
      continue;
    }
    assessed.push({
      loan_application_id: loan.loan_application_id,
      vehicleno: loan.vehicleno,
      assigned_city: loan.assigned_city,
      assigned_state: loan.assigned_state ?? null,
      city_source: loan.assigned_city_source ?? null,
      distance_km: haversineKm(centre.lat, centre.lng, s.lat, s.lon),
      current_lat: s.lat,
      current_lon: s.lon,
      city_lat: centre.lat,
      city_lon: centre.lng,
      last_gps_at: s.last_gps_at ? s.last_gps_at.toISOString() : null,
    });
  }

  const excluded = [
    noCity > 0 ? `${noCity} with no borrower or dealer city on record` : null,
    unknownCity > 0 ? `${unknownCity} whose city name is not in the centroid index` : null,
    noVehicle > 0 ? `${noVehicle} with no vehicle number` : null,
    noFix > 0 ? `${noFix} with no GPS position at all` : null,
    staleFix > 0
      ? `${staleFix} whose last fix is older than ${thresholds.offline_alert_hours}h (see the telemetry-silent card)`
      : null,
  ].filter((x): x is string => x !== null);

  if (assessed.length === 0) {
    return notAssessable(
      slug,
      `Not assessable — none of the ${loans.length} loans have both an assigned city and a fresh GPS fix to measure against.`,
      excluded.length ? [`Excluded: ${excluded.join("; ")}.`] : [],
    );
  }

  const outside = assessed
    .filter((r) => r.distance_km > radiusKm)
    .sort((a, b) => b.distance_km - a.distance_km);

  // Same cutoffs as geo-shift: a single diverted asset in a 200-loan book is a
  // High Alert, because one vehicle in the wrong city is one repossession.
  const severity = pickSeverity(outside.length / Math.max(assessed.length, 1), 0.005, 0.001);

  return {
    slug,
    severity,
    verdict_source: "hand_coded",
    finding_summary:
      outside.length === 0
        ? `All ${assessed.length} assessed vehicles are within ${radiusKm} km of their assigned city.`
        : `${outside.length} of ${assessed.length} assessed vehicles are more than ${radiusKm} km outside their assigned city.`,
    affected_count: outside.length,
    total_count: assessed.length,
    evidence: {
      sample_rows: outside.slice(0, 10).map((r) => ({
        ...r,
        distance_km: Math.round(r.distance_km),
      })),
      chart: {
        kind: "bar",
        data: outside.slice(0, 10).map((r) => ({ x: r.vehicleno, y: Math.round(r.distance_km) })),
      },
      notes: [
        `Threshold: more than ${radiusKm} km from the assigned city's centre (governed city_geofence_km rule).`,
        "Assigned city = the borrower's city on the loan's lead, else the selling dealer's city; the sample rows say which.",
        "Distance is measured from the CITY CENTRE (country-state-city centroids), not a municipal boundary — a large city's outskirts can sit 15–20 km from its centre.",
        `Only fixes newer than ${thresholds.offline_alert_hours}h count as a position (governed offline_alert_hours rule).`,
        ...(excluded.length
          ? [`${loans.length - assessed.length} of ${loans.length} loans excluded — ${excluded.join("; ")}. A coverage gap, not a clean result.`]
          : []),
      ],
      thresholds: {
        city_geofence_km: radiusKm,
        offline_alert_hours: thresholds.offline_alert_hours,
      },
    },
  };
}
