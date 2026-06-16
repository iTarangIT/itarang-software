// Shapes raw GST extraction `fields` (from the shared Gemini extractor) into the
// `gstAddresses` snapshot object the admin Dealer-Verification page renders.
//
// A GST certificate has ONE Principal Place of Business and zero or more
// Additional Place(s) of Business in the State. We surface each as a card the
// admin can tag with role(s) — billing / dispatch / other. When there are no
// additional places, the principal defaults to BOTH billing and dispatch.
//
// Used by both onboarding paths: the WhatsApp orchestrator (gst doc case) and
// the web GST-OCR endpoint. Storage is the submission snapshot — no DB column.

export type AddressRole = "billing" | "dispatch" | "other";

export interface GstAddress {
  /** Stable id so admin role edits survive re-save: "principal", "add-1", … */
  id: string;
  label: string;
  addressLine1: string;
  city: string;
  district: string;
  state: string;
  pincode: string;
  /** Full address line as printed, when available. */
  raw: string;
  roles: AddressRole[];
}

export interface GstAddresses {
  /** GST "Total Number of Additional Places of Business in the State". */
  additionalCount: number;
  principal: GstAddress;
  additional: GstAddress[];
}

/** Coerce any value to a trimmed string ("" for null/undefined/objects). */
function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function toInt(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(str(v), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Build one address card from a flat {address_line1,city,…} object. */
function cardFromObj(
  obj: Record<string, unknown>,
  id: string,
  label: string,
  roles: AddressRole[],
): GstAddress {
  return {
    id,
    label,
    addressLine1: str(obj.address_line1),
    city: str(obj.city),
    district: str(obj.district),
    state: str(obj.state),
    pincode: str(obj.pincode),
    raw: str(obj.full_address) || str(obj.address),
    roles,
  };
}

/** True when an address card carries no usable location data. */
function isEmptyCard(a: GstAddress): boolean {
  return !a.addressLine1 && !a.city && !a.district && !a.state && !a.pincode && !a.raw;
}

/**
 * Map extracted GST `fields` → `gstAddresses`. Tolerates messy model output:
 * `additional_places` may be absent, null, or a non-array.
 */
export function buildGstAddresses(fields: Record<string, unknown>): GstAddresses {
  const rawAdditional = Array.isArray(fields.additional_places)
    ? (fields.additional_places as unknown[])
    : [];

  const additional: GstAddress[] = rawAdditional
    .filter((o): o is Record<string, unknown> => o != null && typeof o === "object")
    .map((o, i) =>
      cardFromObj(o, `add-${i + 1}`, `Additional Place ${i + 1}`, []),
    )
    .filter((a) => !isEmptyCard(a));

  // Default roles: principal is billing+dispatch when it's the only address;
  // otherwise principal=billing and the first additional place=dispatch.
  const principalRoles: AddressRole[] =
    additional.length === 0 ? ["billing", "dispatch"] : ["billing"];
  if (additional.length > 0) additional[0].roles = ["dispatch"];

  const principal = cardFromObj(
    fields,
    "principal",
    "Principal Place of Business",
    principalRoles,
  );

  return {
    additionalCount: toInt(fields.additional_places_count) || additional.length,
    principal,
    additional,
  };
}
