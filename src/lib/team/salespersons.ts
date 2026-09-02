// E-277 — dealer sales-team CRUD, shared by the WhatsApp "My Team" flow, the
// dealer-portal Team page and (later) admin. All identity semantics live here
// so the three surfaces cannot drift: phone normalisation, the add-time
// conflict checks, and deactivate-not-delete.

import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  dealerExtraNumbers,
  dealerOnboardingApplications,
  dealers,
  dealerSalespersons,
  whatsappOperators,
} from "@/lib/db/schema";
import { phoneLookupVariants } from "@/lib/ai/phone";

export interface TeamMember {
  id: string;
  dealerCode: string;
  waPhone: string;
  displayName: string;
  isActive: boolean;
  addedVia: string;
  createdAt: Date;
  deactivatedAt: Date | null;
}

/** Normalise a typed phone into the storage form Meta delivers ("919876543210").
 *  Same rule as operator-identity.toWaPhone. */
export function toWaPhone(raw: string): string | null {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

function phoneVariants(waPhone: string): string[] {
  return [...new Set<string>([waPhone, ...phoneLookupVariants(waPhone)])];
}

export async function listTeam(
  dealerCode: string,
  opts: { includeInactive?: boolean } = {},
): Promise<TeamMember[]> {
  const conds = [eq(dealerSalespersons.dealer_code, dealerCode)];
  if (!opts.includeInactive) {
    conds.push(eq(dealerSalespersons.is_active, true));
  }
  const rows = await db
    .select({
      id: dealerSalespersons.id,
      dealerCode: dealerSalespersons.dealer_code,
      waPhone: dealerSalespersons.wa_phone,
      displayName: dealerSalespersons.display_name,
      isActive: dealerSalespersons.is_active,
      addedVia: dealerSalespersons.added_via,
      createdAt: dealerSalespersons.created_at,
      deactivatedAt: dealerSalespersons.deactivated_at,
    })
    .from(dealerSalespersons)
    .where(and(...conds))
    .orderBy(desc(dealerSalespersons.created_at));
  return rows;
}

/** Why a phone number cannot become a salesperson. Rendered as a friendly
 *  message by each surface. */
export type AddConflict =
  | "invalid_phone"
  | "already_salesperson_here" // active member of THIS dealer's team
  | "already_salesperson_elsewhere" // active member of another dealer's team
  | "is_operator" // iTarang internal onboarding operator (E-214)
  | "is_dealer" // an approved/active dealer's own number
  | "is_own_number"; // the adding dealer's own inbound number

export type AddResult =
  | { ok: true; member: TeamMember }
  | { ok: false; reason: AddConflict };

/**
 * Check every identity a phone could already hold. A number that is any of
 * these would be hijacked (or hijack the team gate) if it also resolved as a
 * salesperson — the runTurn gate order makes phone identity load-bearing.
 */
async function findConflict(
  dealerCode: string,
  waPhone: string,
  dealerOwnPhone?: string | null,
): Promise<AddConflict | null> {
  const variants = phoneVariants(waPhone);

  if (dealerOwnPhone && phoneVariants(dealerOwnPhone).includes(waPhone)) {
    return "is_own_number";
  }

  const [sp] = await db
    .select({ dealerCode: dealerSalespersons.dealer_code })
    .from(dealerSalespersons)
    .where(
      and(
        inArray(dealerSalespersons.wa_phone, variants),
        eq(dealerSalespersons.is_active, true),
      ),
    )
    .limit(1);
  if (sp) {
    return sp.dealerCode === dealerCode
      ? "already_salesperson_here"
      : "already_salesperson_elsewhere";
  }

  const [op] = await db
    .select({ id: whatsappOperators.id })
    .from(whatsappOperators)
    .where(
      and(
        inArray(whatsappOperators.wa_phone, variants),
        eq(whatsappOperators.is_active, true),
      ),
    )
    .limit(1);
  if (op) return "is_operator";

  // An approved dealer's own number — either surface it resolves through.
  const [app] = await db
    .select({ id: dealerOnboardingApplications.id })
    .from(dealerOnboardingApplications)
    .where(
      and(
        inArray(dealerOnboardingApplications.wa_phone, variants),
        eq(dealerOnboardingApplications.onboarding_status, "approved"),
        eq(dealerOnboardingApplications.dealer_account_status, "active"),
      ),
    )
    .limit(1);
  if (app) return "is_dealer";

  const [dealerRow] = await db
    .select({ id: dealers.dealer_id })
    .from(dealers)
    .where(
      and(
        inArray(dealers.owner_phone, variants),
        eq(dealers.onboarding_status, "active"),
      ),
    )
    .limit(1);
  if (dealerRow) return "is_dealer";

  // E-279: an admin-registered EXTRA main number resolves as the full dealer
  // console (gate 12), which would shadow the salesperson gate's semantics —
  // same class of conflict as a primary dealer number. Guarded: an environment
  // without the E-279 table behaves pre-E-279.
  try {
    const [extra] = await db
      .select({ id: dealerExtraNumbers.id })
      .from(dealerExtraNumbers)
      .where(
        and(
          inArray(dealerExtraNumbers.wa_phone, variants),
          eq(dealerExtraNumbers.is_active, true),
        ),
      )
      .limit(1);
    if (extra) return "is_dealer";
  } catch (err) {
    console.error(
      "[team/salespersons] extra-number check failed (is E-279 applied?):",
      err,
    );
  }

  return null;
}

export async function addSalesperson(params: {
  dealerCode: string;
  /** Phone as typed — normalised here. */
  phone: string;
  displayName: string;
  addedBy: string | null;
  addedVia: "whatsapp" | "portal" | "admin";
  /** The dealer's own inbound wa_phone, when known (WhatsApp add path). */
  dealerOwnPhone?: string | null;
}): Promise<AddResult> {
  const waPhone = toWaPhone(params.phone);
  if (!waPhone) return { ok: false, reason: "invalid_phone" };

  const conflict = await findConflict(
    params.dealerCode,
    waPhone,
    params.dealerOwnPhone,
  );
  if (conflict) return { ok: false, reason: conflict };

  try {
    const [row] = await db
      .insert(dealerSalespersons)
      .values({
        dealer_code: params.dealerCode,
        wa_phone: waPhone,
        display_name: params.displayName.trim(),
        added_by: params.addedBy,
        added_via: params.addedVia,
      })
      .returning({
        id: dealerSalespersons.id,
        dealerCode: dealerSalespersons.dealer_code,
        waPhone: dealerSalespersons.wa_phone,
        displayName: dealerSalespersons.display_name,
        isActive: dealerSalespersons.is_active,
        addedVia: dealerSalespersons.added_via,
        createdAt: dealerSalespersons.created_at,
        deactivatedAt: dealerSalespersons.deactivated_at,
      });
    return { ok: true, member: row };
  } catch (err: unknown) {
    // Race on dealer_salespersons_active_phone_key (unlocked check-then-insert
    // by design, like getOrCreateSession) — report it as the conflict it is.
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      return { ok: false, reason: "already_salesperson_elsewhere" };
    }
    throw err;
  }
}

/**
 * Deactivate (never delete): leads keep their salesperson_id history and the
 * number is freed for a future re-add (fresh row). Scoped by dealer_code so a
 * caller can only remove members of their own team. Returns the member, or
 * null when no active row matched.
 */
export async function deactivateSalesperson(params: {
  dealerCode: string;
  salespersonId: string;
  deactivatedBy: string | null;
}): Promise<TeamMember | null> {
  const [row] = await db
    .update(dealerSalespersons)
    .set({
      is_active: false,
      deactivated_at: new Date(),
      deactivated_by: params.deactivatedBy,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(dealerSalespersons.id, params.salespersonId),
        eq(dealerSalespersons.dealer_code, params.dealerCode),
        eq(dealerSalespersons.is_active, true),
      ),
    )
    .returning({
      id: dealerSalespersons.id,
      dealerCode: dealerSalespersons.dealer_code,
      waPhone: dealerSalespersons.wa_phone,
      displayName: dealerSalespersons.display_name,
      isActive: dealerSalespersons.is_active,
      addedVia: dealerSalespersons.added_via,
      createdAt: dealerSalespersons.created_at,
      deactivatedAt: dealerSalespersons.deactivated_at,
    });
  return row ?? null;
}
