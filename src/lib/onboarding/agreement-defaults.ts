// Derived defaults for the Schedule-3 "Dealer Onboarding Details" block of the
// dealer agreement.
//
// Vehicle Type / Manufacturer / Brand / State (Presence) are only captured in
// the web Step-5 agreement form, and only when "OEM financing" is ticked
// (see src/components/onboarding/onboardingSchemas.ts). WhatsApp dealers and
// every non-OEM dealer therefore reach agreement initiation with those four
// fields blank, and Schedule 3 printed four empty cells.
//
// Nothing here invents dealer-specific data: the three product fields are
// constants describing what iTarang finances, and the state is READ from the
// dealer's own address. An explicitly-captured value always wins.

import { extractAddress } from "./dealer-address";

/** The product line every iTarang dealer agreement covers. */
export const DEFAULT_VEHICLE_TYPE = "E-Rickshaw / E-Cart";
export const DEFAULT_MANUFACTURER = "iTarang";
export const DEFAULT_BRAND = "iTarang";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function firstNonEmpty(...values: unknown[]): string {
  for (const v of values) {
    const s = str(v);
    if (s) return s;
  }
  return "";
}

/**
 * The structured parts of the dealer's office address, read from the GST
 * `gstAddresses.principal` snapshot (see ./gst-addresses.ts). The agreement
 * template accepts companyCity/District/State/PinCode and joins them onto the
 * company address line, but the initiate route only ever sent the single joined
 * string — so a thin business_address produced a thin office address.
 */
export function companyAddressParts(gstAddressesSnapshot: unknown): {
  companyCity: string;
  companyDistrict: string;
  companyState: string;
  companyPinCode: string;
} {
  const p =
    (gstAddressesSnapshot as { principal?: Record<string, unknown> } | null)
      ?.principal ?? {};
  return {
    companyCity: str(p.city),
    companyDistrict: str(p.district),
    companyState: str(p.state),
    companyPinCode: str(p.pincode),
  };
}

/**
 * The dealer's state, for Schedule 3's "State (Presence)". Prefers the owner's
 * residential state, then the GST principal place of business, then whatever
 * state the business_address column holds.
 */
export function resolveStatePresence(params: {
  ownershipSnapshot?: Record<string, unknown> | null;
  gstAddressesSnapshot?: unknown;
  businessAddress?: unknown;
}): string {
  const gstState = companyAddressParts(params.gstAddressesSnapshot).companyState;

  // business_address is a TEXT column that may hold a JSON object; read its
  // `state` key when present, else fall back to the flattened address line.
  let bizState = "";
  const raw = params.businessAddress;
  if (raw) {
    let parsed: unknown = raw;
    if (typeof parsed === "string") {
      const trimmed = parsed.trim();
      if (trimmed.startsWith("{")) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          parsed = null;
        }
      } else {
        parsed = null;
      }
    }
    if (parsed && typeof parsed === "object") {
      bizState = str((parsed as Record<string, unknown>).state);
    }
  }

  return firstNonEmpty(params.ownershipSnapshot?.ownerState, gstState, bizState);
}

/**
 * Fill the four Schedule-3 product/presence fields. Any value the admin's
 * agreement config already carries is passed through untouched.
 */
export function resolveScheduleThreeDefaults(params: {
  vehicleType?: string | null;
  manufacturer?: string | null;
  brand?: string | null;
  statePresence?: string | null;
  ownershipSnapshot?: Record<string, unknown> | null;
  gstAddressesSnapshot?: unknown;
  businessAddress?: unknown;
}): {
  vehicleType: string;
  manufacturer: string;
  brand: string;
  statePresence: string;
} {
  return {
    vehicleType: str(params.vehicleType) || DEFAULT_VEHICLE_TYPE,
    manufacturer: str(params.manufacturer) || DEFAULT_MANUFACTURER,
    brand: str(params.brand) || DEFAULT_BRAND,
    statePresence:
      str(params.statePresence) ||
      resolveStatePresence({
        ownershipSnapshot: params.ownershipSnapshot,
        gstAddressesSnapshot: params.gstAddressesSnapshot,
        businessAddress: params.businessAddress,
      }),
  };
}

// Re-exported for callers that already import from this module and also need the
// office-address normaliser.
export { extractAddress };
