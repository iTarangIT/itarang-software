/**
 * The probe registry. Every probe the scanner can run is collected here. The
 * engine filters out `mutating` probes in safe mode and runs the rest.
 */
import type { Probe } from "../probe-context";
import uploadHeaders from "./upload_headers";
import exposure from "./exposure";
import authz from "./authz";
import idor from "./idor";
import injection from "./injection";

export const ALL_PROBES: Probe[] = [
  ...exposure,
  ...authz,
  ...idor,
  ...injection,
  ...uploadHeaders,
];

/** Probes eligible to run for a given mode (safe excludes state-mutating ones). */
export function probesForMode(mode: "safe" | "aggressive"): Probe[] {
  return mode === "aggressive" ? ALL_PROBES : ALL_PROBES.filter((p) => !p.mutating);
}
