// What a dealer of a given business type (E-202) is allowed to DO.
//
// dealer-type.ts owns the vocabulary and its labels; this file owns the
// consequences. Both the sidebar/dashboard (what you can see) and the API
// guards (what you can reach) read from here, so a module can never be visible
// to a dealer type the server would refuse — the failure mode the buyback auth
// header calls out as "worse than no link at all".
//
// Pure and dependency-free on purpose: imported by client components, server
// routes, and potentially Edge middleware. Nothing here touches the DB — see
// dealer-type-runtime.ts for resolving a logged-in user's stored type.

import { normalizeDealerType } from "./dealer-type";

export type DealerCapabilities = {
  /** New-battery business: leads, loans, assets, inventory, orders, service. */
  newBattery: boolean;
  /** peakAmp buyback: selling old batteries back to iTarang. */
  buyback: boolean;
};

/**
 * An UNRECOGNISED or NULL type resolves to 'new', matching E-202's backfill
 * (`UPDATE ... SET dealer_type = 'new' WHERE dealer_type IS NULL`). That covers
 * legacy rows and the WhatsApp / lead-conversion onboarding paths, which never
 * capture a type — those dealers keep exactly the behaviour they have today
 * rather than losing their portal to a NULL.
 */
export function capabilitiesFor(
  dealerType: string | null | undefined,
): DealerCapabilities {
  switch (normalizeDealerType(dealerType)) {
    case "scrap":
      return { newBattery: false, buyback: true };
    case "both":
      return { newBattery: true, buyback: true };
    case "new":
    default:
      return { newBattery: true, buyback: false };
  }
}

export type AgreementMode = "esign" | "manual";

/**
 * Which agreement flow a dealer type uses.
 *
 * Only 'new' has a drafted agreement to generate, so only 'new' goes through
 * Digio. Scrap and New+Scrap sign on paper and an admin uploads the scan —
 * there is no scrap template to render, and generating the new-battery finance
 * agreement for them would put the wrong contract in front of the dealer.
 *
 * Same default rule as capabilitiesFor: unknown/NULL behaves as 'new', so no
 * existing application silently loses its e-sign flow.
 */
export function agreementModeFor(
  dealerType: string | null | undefined,
): AgreementMode {
  const type = normalizeDealerType(dealerType);
  return type === "scrap" || type === "both" ? "manual" : "esign";
}

/** Convenience predicate — reads better than `=== "manual"` at call sites. */
export function usesManualAgreement(
  dealerType: string | null | undefined,
): boolean {
  return agreementModeFor(dealerType) === "manual";
}
