export type AddressParts = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
};

//hello
/**
 * Collapse an address into a comparable string. Used by duplicate detection
 * to decide whether two dealers share a physical location.
 *
 * Rules:
 *  - lowercase + trim each part
 *  - strip punctuation (commas, periods, slashes, dashes)
 *  - collapse internal whitespace to single spaces
 *  - skip empty parts; join the rest with a single space
 *
 * Two addresses match iff their normalized strings are equal AND non-empty
 * — an empty string on either side never counts as a match (prevents a
 * half-filled record from matching every other record).
 */
export function normalizeAddress(parts: AddressParts): string {
  const pieces: string[] = [];
  for (const raw of [parts.line1, parts.line2, parts.city, parts.state, parts.pincode]) {
    if (raw == null) continue;
    const cleaned = String(raw)
      .toLowerCase()
      .replace(/[.,/\\\-_#]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned) pieces.push(cleaned);
  }
  return pieces.join(" ");
}

export function addressesMatch(a: AddressParts, b: AddressParts): boolean {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  if (!na || !nb) return false;
  return na === nb;
}
