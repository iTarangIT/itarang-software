// Dealer onboarding stores location data in several places — and the flat
// `city`/`state`/`pincode` columns are almost always empty. The real address
// lives in:
//   - business_address / registered_address  (jsonb, often `{ address: "..." }`)
//   - provider_raw_response.submissionSnapshot.ownership.owner{AddressLine1,
//     City,District,State,PinCode}
//   - provider_raw_response.submissionSnapshot.gstAddresses (principal +
//     additional places of business, each with city/district/state/pincode)
//
// buildLocationHaystack flattens all of these into a single lowercased string so
// the State / City / Pincode filters (queue page + Excel export) actually match.

export type LocationSource = {
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  business_address?: unknown;
  registered_address?: unknown;
  provider_raw_response?: unknown;
};

// Owner-address keys to pull from the ownership snapshot. Deliberately narrow so
// bank/account fields in the same object can't produce false location matches.
const OWNER_ADDRESS_KEYS = [
  "ownerAddressLine1",
  "ownerAddressLine2",
  "ownerCity",
  "ownerDistrict",
  "ownerState",
  "ownerPinCode",
  "ownerPincode",
];

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

// Recursively collect every string/number leaf — safe for pure address subtrees
// (business/registered address, gstAddresses) where all fields are location data.
function collectLeaves(value: unknown, out: string[]): void {
  const parsed = parseMaybeJson(value);
  if (parsed === null || parsed === undefined) return;
  if (typeof parsed === "string") {
    if (parsed.trim()) out.push(parsed.trim());
    return;
  }
  if (typeof parsed === "number") {
    out.push(String(parsed));
    return;
  }
  if (Array.isArray(parsed)) {
    for (const v of parsed) collectLeaves(v, out);
    return;
  }
  if (typeof parsed === "object") {
    for (const v of Object.values(parsed as Record<string, unknown>)) collectLeaves(v, out);
  }
}

export function buildLocationHaystack(a: LocationSource): string {
  const parts: string[] = [];

  if (a.city) parts.push(String(a.city));
  if (a.state) parts.push(String(a.state));
  if (a.pincode) parts.push(String(a.pincode));

  collectLeaves(a.business_address, parts);
  collectLeaves(a.registered_address, parts);

  const raw = parseMaybeJson(a.provider_raw_response);
  const snapshot =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).submissionSnapshot
      : undefined;

  if (snapshot && typeof snapshot === "object") {
    const snap = snapshot as Record<string, unknown>;

    const ownership = snap.ownership;
    if (ownership && typeof ownership === "object") {
      const o = ownership as Record<string, unknown>;
      for (const k of OWNER_ADDRESS_KEYS) {
        const v = o[k];
        if (v != null && String(v).trim()) parts.push(String(v).trim());
      }
    }

    // gstAddresses is entirely location data, so a deep collect is safe.
    collectLeaves(snap.gstAddresses, parts);
  }

  return parts.join(" ").toLowerCase();
}
