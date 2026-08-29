/**
 * Human-readable "what this card does" catalogue for the admin Risk Cards
 * screen. The DB `risk_hypotheses.description` is a single prose line; the admin
 * Info panel wants the fuller breakdown — the logic steps, which data each card
 * pulls, what it renders, and how its severity is decided.
 *
 * For the six hand-coded (`source='human'`) cards this is authored from the
 * evaluators in `src/lib/risk/hand-coded-cards.ts` and kept in sync with them.
 * For AI-generated (`llm-v1`) cards — minted at runtime by the LangGraph agent —
 * there is no static entry, so `getCardInfo` falls back to the stored
 * description plus a generic explanation of how agent-authored cards run.
 */

/** A concrete, illustrative "this is what the partner sees" sample. */
export interface RiskCardExample {
  /** The one-line finding summary the partner reads at the top of the card. */
  finding: string;
  /** Severity label the example resolves to — "High Alert" | "Warning" | "OK". */
  severity: string;
  /** A small evidence table, exactly the shape shown in the card's drawer. */
  table: { columns: string[]; rows: string[][] };
  /** Plain-English read of what the partner should do with it. */
  reading: string;
}

/** One input feed the evaluator reads — a table/source row for the Info panel. */
export interface RiskCardInput {
  /** The table or data feed name (e.g. "distance_rollup", "nbfcLoans"). */
  table: string;
  /** Where it comes from, in business terms (e.g. "IoT telemetry"). */
  source: string;
  /** What that feed contributes to the calculation. */
  provides: string;
}

export interface RiskCardInfo {
  /** One-paragraph plain-English purpose (the "function" of the card). */
  whatItDoes: string;
  /**
   * The code that actually computes this card — the evaluator function name and
   * the file it is defined in — surfaced in the Info panel so a reviewer can go
   * straight to the source of the logic.
   */
  evaluator: { fn: string; file: string };
  /** A single-line input → processing → output summary of how the card works. */
  flow: string;
  /** The input tables / data feeds the evaluator reads, as structured rows. */
  inputTables: RiskCardInput[];
  /** Ordered evaluation steps — the function logic, in words. */
  logic: string[];
  /** Every data source the evaluator reads. */
  dataPulled: string[];
  /** What the rendered card / drawer shows the NBFC. */
  dataShown: string[];
  /** How High / Warning / OK / Inconclusive are decided for this card. */
  severityMeaning: string;
  /** Governed or hard-coded thresholds this card is judged by. */
  thresholds: string[];
  /** A worked example of the card's output, for the admin Info panel. */
  example: RiskCardExample;
}

const SEVERITY_VOCAB =
  "Across every card: High Alert and Warning are the two alerting states, OK means the test ran and found nothing, Inconclusive means there was too little data to test, and Error means the evaluator failed to run.";

const HAND_CODED_INFO: Record<string, RiskCardInfo> = {
  "usage-drop-7d": {
    whatItDoes:
      "Flags borrowers whose vehicle mileage fell off a cliff week-over-week. A sudden usage drop typically precedes delinquency by 2–3 weeks, so it is an early-warning signal on a still-current loan.",
    evaluator: { fn: "evalUsageDrop7d()", file: "src/lib/risk/hand-coded-cards.ts" },
    flow: "IN: 14 days of daily km per vehicle → PROCESS: compare last 7 days vs the 7 before, for vehicles that had a real prior week → OUT: the borrowers whose driving dropped by more than the threshold.",
    inputTables: [
      {
        table: "distance_rollup",
        source: "IoT telemetry",
        provides: "Daily kilometres per vehicle for the last 14 days.",
      },
      {
        table: "nbfcLoans",
        source: "CRM loan slice",
        provides: "Each active loan and its vehicle number (links a loan to its telemetry).",
      },
      {
        table: "nbfc_risk_rules",
        source: "Governed threshold",
        provides: "usage_drop_pct — the drop % that counts as a flag (default 40%).",
      },
    ],
    logic: [
      "Pull the last 14 days of daily km for each loan's vehicle.",
      "Split each vehicle into a last-7-days total and a prior-7-days total.",
      "Exclude vehicles with less than 50 km in the prior week — with no real baseline there is nothing to drop from.",
      "drop% = (prior − recent) ÷ prior; a vehicle is flagged when drop% ≥ the governed usage_drop_pct rule (default 40%).",
      "Severity is set by the share of assessed borrowers flagged.",
    ],
    dataPulled: [
      "IoT telemetry — daily km per vehicle over 14 days (distance_rollup).",
      "CRM loan slice — each active loan's vehicle number (nbfcLoans).",
      "Governed threshold — usage_drop_pct from nbfc_risk_rules.",
    ],
    dataShown: [
      "Count of affected vs assessed borrowers.",
      "Top droppers: vehicle no., prior-week km, recent-week km, drop %.",
      "A bar chart of the largest drops.",
      "Coverage notes (how many loans lacked a usable baseline) and the threshold snapshot.",
    ],
    severityMeaning:
      "High = ≥5% of assessed borrowers dropped; Warning = ≥1%; OK = tested, none crossed the threshold; Inconclusive = no vehicle had a usable prior-week baseline.",
    thresholds: ["usage_drop_pct — governed (nbfc_risk_rules), default 40%."],
    example: {
      finding:
        "3 of 40 assessed borrowers had a ≥40% drop in 7-day km vs the prior 7 days.",
      severity: "High Alert",
      table: {
        columns: ["Vehicle", "Prior 7d", "Recent 7d", "Drop"],
        rows: [
          ["MH12AB1234", "210 km", "48 km", "77%"],
          ["MH14CD5678", "185 km", "70 km", "62%"],
          ["MH12EF9012", "160 km", "72 km", "55%"],
        ],
      },
      reading:
        "These three vehicles nearly stopped driving in the last week after a normal prior week — a strong early signal to call the borrower before the EMI is missed.",
    },
  },

  "dpd-7-no-telemetry": {
    whatItDoes:
      "Flags loans that are past due AND whose vehicle has gone GPS-silent. Non-payment combined with silence is a concealment / asset-diversion signal — the borrower has stopped paying and the asset has stopped reporting.",
    evaluator: { fn: "evalDpd7NoTelemetry()", file: "src/lib/risk/hand-coded-cards.ts" },
    flow: "IN: the overdue loans + each vehicle's latest GPS check-in → PROCESS: among borrowers already past due, find the ones whose vehicle has stopped reporting GPS → OUT: the past-due borrowers who have also gone dark.",
    inputTables: [
      {
        table: "nbfcLoans",
        source: "CRM loan slice",
        provides: "Each loan's current days-past-due (DPD) and vehicle number.",
      },
      {
        table: "vehicle GPS state",
        source: "IoT telemetry",
        provides: "How long ago each vehicle last reported a GPS fix.",
      },
      {
        table: "nbfc_risk_rules",
        source: "Governed thresholds",
        provides: "emi_overdue_days (default 30) and offline_alert_hours (default 24).",
      },
    ],
    logic: [
      "Take the overdue pool: loans whose current DPD ≥ the governed emi_overdue_days rule (default 30).",
      "For each overdue loan, look up the vehicle's latest GPS state.",
      "A loan is concerning when the vehicle has no state, or has not reported GPS for longer than the governed offline_alert_hours rule (default 24h).",
      "Severity is set by the share of the overdue pool that is telemetry-silent.",
    ],
    dataPulled: [
      "CRM loan slice — current DPD and vehicle number (nbfcLoans).",
      "IoT telemetry — latest per-vehicle GPS state / seconds-since-last-fix.",
      "Governed thresholds — emi_overdue_days and offline_alert_hours from nbfc_risk_rules.",
    ],
    dataShown: [
      "Count of concerning vs overdue borrowers.",
      "Sample rows: the loan plus how long its vehicle has been GPS-silent.",
      "Pool and threshold notes (size of the overdue pool, silence cut-off).",
    ],
    severityMeaning:
      "High = ≥3% of the overdue pool is silent; Warning = ≥1%; OK = nobody is past due, or nobody past due is silent; scored against the overdue pool, not the whole book.",
    thresholds: [
      "emi_overdue_days — governed (nbfc_risk_rules), default 30 days.",
      "offline_alert_hours — governed (nbfc_risk_rules), default 24 hours.",
    ],
    example: {
      finding:
        "2 of 9 borrowers are 30+ days past due and have not reported GPS for 24h+.",
      severity: "High Alert",
      table: {
        columns: ["Loan", "Vehicle", "DPD", "GPS silent for"],
        rows: [
          ["LN-0489", "DL3CX9911", "41 days", "3 days"],
          ["LN-0512", "DL8SAB2200", "36 days", "31 hours"],
        ],
      },
      reading:
        "These borrowers have stopped paying AND their vehicle has gone dark — a concealment / repossession-risk pattern that warrants immediate field follow-up.",
    },
  },

  "geo-shift": {
    whatItDoes:
      "Flags vehicles operating far from their own usual area. Each vehicle is measured against its own 30-day home base, so a large, sustained displacement can indicate asset diversion.",
    evaluator: { fn: "evalGeoShift()", file: "src/lib/risk/hand-coded-cards.ts" },
    flow: "IN: 30 days of GPS fixes per vehicle → PROCESS: work out each vehicle's usual home area, then measure how far it is from home right now → OUT: the vehicles sitting further from home than the threshold.",
    inputTables: [
      {
        table: "vehicle GPS fixes (30d)",
        source: "IoT telemetry",
        provides: "Location history to build the home base plus the current position.",
      },
      {
        table: "nbfcLoans",
        source: "CRM loan slice",
        provides: "Vehicle number (links a loan to its telemetry).",
      },
      {
        table: "nbfc_risk_rules",
        source: "Governed threshold",
        provides: "geo_shift_km — how far from home counts as out of area.",
      },
    ],
    logic: [
      "Build each vehicle's home base — its most-visited ~11 km GPS cell over the last 30 days.",
      "Exclude vehicles without enough GPS history to establish a home base (too few fixes in the modal cell) — measuring distance from noise would be meaningless.",
      "Flag vehicles whose current position is more than the governed geo_shift_km rule from their home base.",
      "Severity is set by the share of assessable vehicles that are out of area.",
    ],
    dataPulled: [
      "IoT telemetry — 30 days of GPS fixes per vehicle (home-base clustering + current position).",
      "CRM loan slice — vehicle number (nbfcLoans).",
      "Governed threshold — geo_shift_km from nbfc_risk_rules.",
    ],
    dataShown: [
      "Count of out-of-area vs assessed vehicles.",
      "Sample rows: vehicle no., distance from home (km), current lat/lon, home lat/lon.",
      "Home-base methodology note and a coverage-gap note for vehicles excluded for thin GPS history.",
    ],
    severityMeaning:
      "High = ≥0.5% of assessed vehicles are out of area; Warning = ≥0.1%; OK = tested, none out of area; Inconclusive = no vehicle had enough GPS history to establish a home base.",
    thresholds: ["geo_shift_km — governed (nbfc_risk_rules)."],
    example: {
      finding:
        "1 of 120 vehicles is more than 25 km from its usual operating area.",
      severity: "High Alert",
      table: {
        columns: ["Vehicle", "Home base", "Now", "Distance"],
        rows: [["DL3CX9911", "Karol Bagh, Delhi", "Meerut, UP", "63 km"]],
      },
      reading:
        "This vehicle has moved well outside the 30-day area it normally works in — possible asset diversion or an unreported sale; verify who is operating it.",
    },
  },

  "battery-soh-decay": {
    whatItDoes:
      "Flags vehicles whose battery State-of-Health is degrading unusually fast. Accelerated decay erodes both the asset's collateral value and the operator's earning capacity.",
    evaluator: { fn: "evalBatterySohDecay()", file: "src/lib/risk/hand-coded-cards.ts" },
    flow: "IN: battery State-of-Health readings over 30 days → PROCESS: compare each vehicle's oldest reading with its newest → OUT: the vehicles that lost more than 5 health points in the month.",
    inputTables: [
      {
        table: "SOH readings (30d)",
        source: "IoT telemetry",
        provides: "Battery State-of-Health at the start (baseline) and end (current) of the window.",
      },
      {
        table: "nbfcLoans",
        source: "CRM loan slice",
        provides: "Vehicle number (links a loan to its telemetry).",
      },
    ],
    logic: [
      "For each vehicle, compute SOH change over 30 days: oldest reading in the window is the baseline, newest is the current value.",
      "Only vehicles with an SOH reading at both ends of the window are assessable.",
      "Flag a vehicle when SOH dropped by more than 5 percentage points in 30 days.",
      "Severity is set by the share of measured vehicles flagged.",
    ],
    dataPulled: [
      "IoT telemetry — per-vehicle SOH readings over 30 days (baseline vs current).",
      "CRM loan slice — vehicle number (nbfcLoans).",
    ],
    dataShown: [
      "Count of concerning vs assessed vehicles.",
      "Sample rows with the SOH delta.",
      "Baseline/current methodology note and a note that the 5pp threshold is hard-coded.",
    ],
    severityMeaning:
      "High = ≥2% of measured vehicles decayed past the threshold; Warning = ≥0.5%; OK = tested, none past threshold; Inconclusive = no vehicle had SOH readings at both ends of the window.",
    thresholds: [
      "5 percentage-point SOH drop in 30 days — hard-coded (there is no battery-degradation rule in the governed catalogue).",
    ],
    example: {
      finding:
        "2 of 85 assessed vehicles show a >5pp SOH drop in the last 30 days.",
      severity: "High Alert",
      table: {
        columns: ["Vehicle", "SOH 30d ago", "SOH now", "Drop"],
        rows: [
          ["MH12EF9012", "92%", "84%", "8 pp"],
          ["MH14GH3456", "88%", "82%", "6 pp"],
        ],
      },
      reading:
        "These batteries are ageing faster than normal — collateral value and the operator's daily range are both falling, which can pressure repayment.",
    },
  },

  "low-utilization-active-loan": {
    whatItDoes:
      "Flags loans that are actively repaying but whose vehicle is barely being driven. Under-utilisation on an active EMI can mean the operator is churning, sub-letting, or losing the income that services the loan.",
    evaluator: { fn: "evalLowUtilizationActiveLoan()", file: "src/lib/risk/hand-coded-cards.ts" },
    flow: "IN: loans with a live EMI + 14 days of daily km → PROCESS: average each vehicle's km over the days it actually reported → OUT: the active-EMI vehicles averaging under 20 km/day.",
    inputTables: [
      {
        table: "nbfcLoans",
        source: "CRM loan slice",
        provides: "EMI amount (to keep only live loans) and vehicle number.",
      },
      {
        table: "distance_rollup",
        source: "IoT telemetry",
        provides: "Daily kilometres per vehicle for the last 14 days.",
      },
    ],
    logic: [
      "Take loans with an EMI obligation greater than zero.",
      "Pull the last 14 days of daily km for those vehicles.",
      "Average km over the days the vehicle actually reported — a missing day is a pipeline gap, not a zero-km day, so it is not counted.",
      "Exclude vehicles with no telemetry at all, or fewer than 7 reporting days, as unmeasurable.",
      "Flag vehicles averaging under 20 km/day; severity is set by the share of the assessable population flagged.",
    ],
    dataPulled: [
      "CRM loan slice — EMI amount and vehicle number (nbfcLoans).",
      "IoT telemetry — daily km per vehicle over 14 days (distance_rollup).",
    ],
    dataShown: [
      "Count of under-utilised vs assessable vehicles.",
      "Sample rows: average km/day, days reported, EMI amount.",
      "Coverage notes for vehicles with no telemetry or too few reporting days, and a note that the 20 km/day threshold is hard-coded.",
    ],
    severityMeaning:
      "High = ≥10% of assessable vehicles are under-utilised; Warning = ≥4%; OK = tested, none under-utilised; Inconclusive = no active-EMI vehicle reported on at least 7 of the last 14 days.",
    thresholds: [
      "20 km/day over a 14-day window — hard-coded (no governed rule).",
      "Minimum 7 reporting days to be assessable.",
    ],
    example: {
      finding:
        "4 of 30 assessable vehicles averaged <20 km/day across the days they reported.",
      severity: "High Alert",
      table: {
        columns: ["Vehicle", "Avg km/day", "Days reported", "EMI"],
        rows: [
          ["MH12AB1234", "11 km", "12", "₹4,200"],
          ["MH14CD5678", "14 km", "10", "₹3,850"],
          ["MH12EF9012", "17 km", "13", "₹4,200"],
        ],
      },
      reading:
        "These vehicles are barely being driven despite an active EMI — the operator may have stopped using or sub-let the vehicle, threatening the income that services the loan.",
    },
  },

  "outside-assigned-city": {
    whatItDoes:
      "Flags financed vehicles whose latest GPS position is outside the city the loan was written for — the borrower's city, or the selling dealer's when the borrower's is blank. Unlike the geo-shift card, which measures against wherever the vehicle has recently been, this measures against a fixed, agreed location, so an asset that has quietly relocated stays flagged.",
    evaluator: { fn: "evalOutsideAssignedCity()", file: "src/lib/risk/hand-coded-cards.ts" },
    flow: "IN: each loan's assigned city + each vehicle's latest GPS fix → PROCESS: look up the city's centre, measure the distance to the fix → OUT: the vehicles further from their city centre than the governed radius.",
    inputTables: [
      {
        table: "nbfcLoans → loan_sanctions → leads / accounts",
        source: "CRM loan slice",
        provides: "Each active loan's vehicle number and its assigned city (borrower's `leads.city`, falling back to the dealer's `accounts.city`).",
      },
      {
        table: "vehicle_state",
        source: "IoT telemetry",
        provides: "Latest lat/lon per vehicle and how long ago it was reported.",
      },
      {
        table: "country-state-city index",
        source: "Static city centroids",
        provides: "Centre coordinates for 4,242 Indian cities (no coordinates exist on CRM records).",
      },
      {
        table: "nbfc_risk_rules",
        source: "Governed thresholds",
        provides: "city_geofence_km (default 25) and offline_alert_hours (default 24).",
      },
    ],
    logic: [
      "Resolve each loan's assigned city: the borrower's city on the sanction's lead, else the selling dealer's city.",
      "Look up the city's centre coordinates; a city name the index does not know is excluded, not guessed.",
      "Take the vehicle's latest GPS fix; a fix older than the governed offline_alert_hours is excluded — the vehicle's position is unknown, which is the telemetry-silent card's finding, not this one's.",
      "Flag the vehicle when the great-circle distance from the city centre exceeds the governed city_geofence_km rule.",
      "Severity is set by the share of assessed vehicles outside their city.",
    ],
    dataPulled: [
      "CRM loan slice — vehicle number + assigned city and its source (nbfcLoans joined to loan_sanctions → leads → accounts).",
      "IoT telemetry — latest per-vehicle position and fix age (vehicle_state).",
      "Governed thresholds — city_geofence_km and offline_alert_hours from nbfc_risk_rules.",
    ],
    dataShown: [
      "Count of out-of-city vs assessed vehicles.",
      "Sample rows: loan, vehicle no., assigned city (and whether it came from the borrower or dealer), distance from the city centre, current lat/lon, last fix time.",
      "A bar chart of the furthest vehicles.",
      "Coverage notes: how many loans had no city, an unknown city, no vehicle, no fix, or a stale fix.",
    ],
    severityMeaning:
      "High = ≥0.5% of assessed vehicles are outside their city; Warning = ≥0.1%; OK = tested, all inside; Inconclusive = no loan had both an assigned city and a fresh GPS fix.",
    thresholds: [
      "city_geofence_km — governed (nbfc_risk_rules), default 25 km from the city centre.",
      "offline_alert_hours — governed (nbfc_risk_rules); older fixes are not treated as a position.",
    ],
    example: {
      finding: "2 of 118 assessed vehicles are more than 25 km outside their assigned city.",
      severity: "High Alert",
      table: {
        columns: ["Loan", "Vehicle", "Assigned city", "Now", "Distance"],
        rows: [
          ["LN-0412", "UP32KX4410", "Lucknow (borrower)", "Kanpur", "78 km"],
          ["LN-0388", "DL8SAB2200", "Delhi (dealer)", "Panipat", "84 km"],
        ],
      },
      reading:
        "These vehicles are operating in a different city from the one the loan was written for — possible relocation or an unreported sale. Confirm with the borrower and the field team before the next EMI falls due.",
    },
  },
};

/**
 * Resolve the Info-panel content for a card. Hand-coded cards get the authored
 * breakdown above; anything else (AI-generated) gets a generic explanation built
 * from its stored description.
 */
export function getCardInfo(card: {
  slug: string;
  description: string;
  source: string;
}): RiskCardInfo {
  const authored = HAND_CODED_INFO[card.slug];
  if (authored) return authored;

  // AI-generated / unknown hypothesis — no hand-authored breakdown exists.
  return {
    whatItDoes:
      card.description ||
      "AI-generated risk hypothesis. See the stored description for its intent.",
    evaluator: {
      fn: "Agent-authored test (test_definition)",
      file: "executed deterministically in the risk sandbox",
    },
    flow: "IN: the partner's loan slice + whatever telemetry the agent-written test asks for → PROCESS: the AI-authored test runs in the risk sandbox → OUT: the borrowers that matched, capped at Warning until a reviewer promotes the card.",
    inputTables: [
      {
        table: "nbfcLoans",
        source: "CRM loan slice",
        provides: "The partner's active loans and their vehicle numbers.",
      },
      {
        table: "IoT telemetry",
        source: "Risk sandbox",
        provides: "Whatever telemetry the agent-authored test (test_definition) reads.",
      },
    ],
    logic: [
      "This hypothesis was proposed and authored by the risk-engine AI agent, not hand-coded.",
      "Its test is agent-written Python, executed deterministically in the risk sandbox on each run.",
      "Until a reviewer promotes it, its severity is capped at Warning (unvetted).",
    ],
    dataPulled: [
      "The tenant's loan slice (nbfcLoans) and the IoT telemetry available to the sandbox.",
      "The exact inputs are defined by the agent-authored test (test_definition).",
    ],
    dataShown: [
      "Affected vs total counts, a finding summary, sample evidence rows, and any methodology notes produced at run time.",
    ],
    severityMeaning:
      "Severity is computed per run. Unvetted AI hypotheses are capped at Warning until a reviewer promotes them from the NBFC Risk dashboard.",
    thresholds: ["Defined inside the agent-authored test."],
    example: {
      finding:
        "3 of 50 borrowers in this partner's book matched this hypothesis on the last run.",
      severity: "Warning",
      table: {
        columns: ["Loan", "Vehicle", "Why it matched"],
        rows: [
          ["LN-0231", "MH12AB1234", "Crossed this hypothesis's threshold"],
          ["LN-0288", "MH14CD5678", "Crossed this hypothesis's threshold"],
          ["LN-0301", "MH12EF9012", "Crossed this hypothesis's threshold"],
        ],
      },
      reading:
        "Representative sample — the live card lists the exact borrowers flagged and the specific values behind each match. Being AI-authored and unvetted, it is capped at Warning until a reviewer promotes it.",
    },
  };
}

export { SEVERITY_VOCAB };
