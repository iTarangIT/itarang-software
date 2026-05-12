/**
 * Shared catalogue + helpers for the Risk Rule Engine (BRD §6.3.3).
 *
 * The eight canonical rule_keys, their human labels, units and BRD defaults
 * live here so that both the GET endpoint and the POST /preview endpoint
 * agree on the catalogue. The DB row is the source of truth for the *current*
 * value; this module just keeps labels and the enum stable across the route
 * handler, the dual-approval gate (E-085), and the admin UI.
 */

export const RISK_RULE_KEYS = [
  "cds_low_medium",
  "cds_medium_high",
  "cds_high_very_high",
  "emi_overdue_days",
  "usage_drop_pct",
  "geo_shift_km",
  "offline_alert_hours",
  "pci_concern",
] as const;

export type RiskRuleKey = (typeof RISK_RULE_KEYS)[number];

type Catalogue = Record<
  RiskRuleKey,
  { label: string; unit: string; default_value: number }
>;

export const RISK_RULE_CATALOGUE: Catalogue = {
  cds_low_medium:      { label: "CDS: Low/Medium threshold",     unit: "score", default_value: 40 },
  cds_medium_high:     { label: "CDS: Medium/High threshold",    unit: "score", default_value: 70 },
  cds_high_very_high:  { label: "CDS: High/Very High threshold", unit: "score", default_value: 85 },
  emi_overdue_days:    { label: "EMI Overdue Trigger",           unit: "days",  default_value: 30 },
  usage_drop_pct:      { label: "Usage Drop Threshold",          unit: "pct",   default_value: 40 },
  geo_shift_km:        { label: "Geo-Shift Threshold",           unit: "km",    default_value: 100 },
  offline_alert_hours: { label: "Offline Alert Threshold",       unit: "hours", default_value: 24 },
  pci_concern:         { label: "PCI: Concern threshold",        unit: "score", default_value: 0.4 },
};

/** True if `key` is one of the eight canonical rule keys. */
export function isRiskRuleKey(key: string): key is RiskRuleKey {
  return (RISK_RULE_KEYS as readonly string[]).includes(key);
}
