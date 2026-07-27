// E-214 — map an inbound WhatsApp number to an internal onboarding OPERATOR.
//
// An operator is a member of the iTarang onboarding team who runs many dealer
// onboardings from their own single WhatsApp number. This lookup is the gate
// that separates them from ordinary senders in runTurn().
//
// Why an explicit allowlist table and not users.role / users.phone:
// resolveKnownContact() (dealer-identity.ts) already matches users.phone for a
// purely COSMETIC greeting ("You're registered with iTarang as Sales Manager").
// users.phone is free-text and unvalidated, so making it load-bearing would
// silently promote every staff member with a mobile on file into an operator —
// letting them create dealer accounts. whatsapp_operators is admin-managed, has
// its own activation switch, and links users.id only for attribution.

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { whatsappOperators } from "@/lib/db/schema";
import { phoneLookupVariants } from "@/lib/ai/phone";

export interface WhatsAppOperator {
  id: string;
  /** As stored — E.164 without '+'. */
  waPhone: string;
  displayName: string;
  /** Optional CRM login link; null for operators with no dashboard account. */
  userId: string | null;
  email: string | null;
}

/**
 * Every storage variant an inbound wa_phone ("919876543210", no '+') might be
 * stored as. Same rule as dealer-identity.phoneVariants, kept separate so the
 * two lookups can diverge without surprising each other.
 */
function phoneVariants(waPhone: string): string[] {
  return [...new Set<string>([waPhone, ...phoneLookupVariants(waPhone)])];
}

/**
 * Resolve an inbound WhatsApp phone to an ACTIVE internal operator, or null.
 * Null → the caller falls through to the normal dealer/customer routing, so an
 * empty allowlist leaves the pre-E-214 behaviour completely unchanged.
 */
export async function resolveOperator(
  waPhone: string,
): Promise<WhatsAppOperator | null> {
  if (!waPhone) return null;

  try {
    const [row] = await db
      .select({
        id: whatsappOperators.id,
        waPhone: whatsappOperators.wa_phone,
        displayName: whatsappOperators.display_name,
        userId: whatsappOperators.user_id,
        email: whatsappOperators.email,
      })
      .from(whatsappOperators)
      .where(
        and(
          inArray(whatsappOperators.wa_phone, phoneVariants(waPhone)),
          eq(whatsappOperators.is_active, true),
        ),
      )
      .limit(1);

    return row ?? null;
  } catch (err) {
    // This runs on EVERY inbound message. If E-214 hasn't been applied yet the
    // table is missing, and throwing here would take down dealer onboarding for
    // everyone. Degrade to "no operators" instead — the pre-E-214 behaviour.
    console.error(
      "[WhatsApp/operator-identity] operator lookup failed (is E-214 applied?):",
      err,
    );
    return null;
  }
}

/**
 * Normalise a phone the admin typed into the storage form Meta delivers
 * ("919876543210" — E.164 digits, no '+'). Mirrors toWaPhone() in the
 * inside-sales invite route so an operator added from the admin page matches the
 * number Meta sends us.
 */
export function toWaPhone(raw: string): string | null {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  // Longer/other country codes: accept as-is if it looks like a plausible E.164.
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}
