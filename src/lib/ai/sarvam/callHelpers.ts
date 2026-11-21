// Pure helpers for placing and costing a Sarvam call — no DB, no network, no
// env — so they are unit-tested directly (__tests__/sarvamCall.test.ts).

import type { SarvamAgentVariables, SarvamCreateOutboundResponse } from "./types";

/** Spoken when a lead has neither a shop name nor an owner name. */
export const SARVAM_SHOP_NAME_FALLBACK = "aapki dukaan";

/**
 * Priya's opening line is "Am I speaking with {{shop_name}}?" and cannot
 * branch on a blank, so shop_name must never be empty: fall back to the owner
 * name, then to a neutral phrase. Pure.
 */
export function buildSarvamAgentVariables(lead: {
  shop_name?: string | null;
  dealer_name?: string | null;
  location?: string | null;
}): SarvamAgentVariables {
  const shop = lead.shop_name?.trim() ?? "";
  const owner = lead.dealer_name?.trim() ?? "";
  return {
    shop_name: shop || owner || SARVAM_SHOP_NAME_FALLBACK,
    owner_name: owner,
    location: lead.location?.trim() ?? "",
  };
}

/** Human-readable text for Sarvam's 422 `detail` list (or any error body). */
export function sarvamErrorText(json: SarvamCreateOutboundResponse | null, httpStatus: number): string {
  const detail = json?.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (Array.isArray(detail) && detail.length > 0) {
    return detail
      .map((d) => {
        const where = Array.isArray(d?.loc) ? d.loc.join(".") : "";
        return [where, d?.msg].filter(Boolean).join(": ");
      })
      .filter(Boolean)
      .join("; ")
      .slice(0, 300);
  }
  return `Sarvam call failed (HTTP ${httpStatus})`;
}

/** Pure: INR paise for a call of `durationSecs` at `inrPerMinute`. */
export function sarvamCostPaise(
  durationSecs: number | null,
  inrPerMinute: number | null,
): number | null {
  if (durationSecs == null || inrPerMinute == null) return null;
  if (!Number.isFinite(durationSecs) || durationSecs < 0) return null;
  return Math.round((durationSecs / 60) * inrPerMinute * 100);
}
