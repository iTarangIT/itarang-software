// Display helpers shared by the WhatsApp state machines and the admin console.
//
// Deliberately dependency-free (no db, no next, no orchestrator) so a "use client"
// component can import it without dragging the 5k-line orchestrator into the
// browser bundle — the same reason session-store.ts was extracted.

/**
 * Seed value for `dealer_onboarding_applications.company_name`, which is NOT NULL
 * but unknown at first contact. Overwritten by fillFromDoc once the GST/PAN is
 * read. The admin console must never render this string — use
 * `prospectDisplayName()` instead.
 */
export const PLACEHOLDER_COMPANY = "WhatsApp onboarding (pending)";

export function isPlaceholderCompany(name: string | null | undefined): boolean {
  return !name || name.trim() === "" || name === PLACEHOLDER_COMPANY;
}

/**
 * Best available name for a WhatsApp prospect, in decreasing order of how much
 * we actually know about them. Someone who has only said "Hi" has no company and
 * no owner name, so we fall back to their WhatsApp profile name and finally to
 * their phone number — never to a blank cell.
 */
export function prospectDisplayName(p: {
  companyName?: string | null;
  ownerName?: string | null;
  contactName?: string | null;
  waPhone?: string | null;
}): string {
  if (!isPlaceholderCompany(p.companyName)) return p.companyName!.trim();
  const owner = p.ownerName?.trim();
  if (owner) return owner;
  const contact = p.contactName?.trim();
  if (contact) return contact;
  const phone = p.waPhone?.trim();
  if (phone) return phone.startsWith("+") ? phone : `+${phone}`;
  return "Unknown contact";
}

/** Pretty-print an E.164-without-plus WhatsApp number for display. */
export function formatWaPhone(waPhone: string | null | undefined): string {
  if (!waPhone) return "—";
  const trimmed = waPhone.trim();
  return trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
}
