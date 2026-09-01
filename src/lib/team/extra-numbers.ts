// E-279 — extra MAIN-dealer WhatsApp numbers CRUD, used by the admin
// "Multiple dealer" tab (/api/admin/dealer-extra-numbers). The full-scope
// sibling of salespersons.ts: an active row resolves the number to the
// dealership's unmodified main-dealer console via resolveWhatsAppDealer()'s
// third lookup step. All identity semantics live here so surfaces cannot
// drift: phone normalisation, the add-time conflict checks, and
// deactivate-not-delete (plus the session reset that keeps a removed number
// from stranding mid-console).

import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  dealerExtraNumbers,
  dealerOnboardingApplications,
  dealers,
  dealerSalespersons,
  whatsappOnboardingSessions,
  whatsappOperators,
} from "@/lib/db/schema";
import { phoneLookupVariants } from "@/lib/ai/phone";

export interface ExtraNumber {
  id: string;
  dealerCode: string;
  waPhone: string;
  displayName: string;
  isActive: boolean;
  notes: string | null;
  createdAt: Date;
  deactivatedAt: Date | null;
}

/** Normalise a typed phone into the storage form Meta delivers ("919876543210").
 *  Same rule as team/salespersons.toWaPhone / operator-identity.toWaPhone. */
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

const RETURNING = {
  id: dealerExtraNumbers.id,
  dealerCode: dealerExtraNumbers.dealer_code,
  waPhone: dealerExtraNumbers.wa_phone,
  displayName: dealerExtraNumbers.display_name,
  isActive: dealerExtraNumbers.is_active,
  notes: dealerExtraNumbers.notes,
  createdAt: dealerExtraNumbers.created_at,
  deactivatedAt: dealerExtraNumbers.deactivated_at,
};

/** List extra numbers — one dealer's when dealerCode is given, else all. */
export async function listExtraNumbers(
  dealerCode?: string | null,
  opts: { includeInactive?: boolean } = {},
): Promise<ExtraNumber[]> {
  const conds = [];
  if (dealerCode) conds.push(eq(dealerExtraNumbers.dealer_code, dealerCode));
  if (!opts.includeInactive) {
    conds.push(eq(dealerExtraNumbers.is_active, true));
  }
  const rows = await db
    .select(RETURNING)
    .from(dealerExtraNumbers)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(dealerExtraNumbers.is_active), desc(dealerExtraNumbers.created_at));
  return rows;
}

/** Why a phone number cannot become an extra main number. Rendered as a
 *  friendly message by the admin API. Unlike operators there is NO override:
 *  a double identity would misroute leads, so every conflict is terminal. */
export type AddConflict =
  | "invalid_phone"
  | "already_extra_here" // active extra number of THIS dealership
  | "already_extra_elsewhere" // active extra number of another dealership
  | "is_operator" // iTarang internal onboarding operator (E-214)
  | "is_salesperson" // active member of some dealer's sales team (E-277)
  | "is_own_number" // the dealership's own primary WhatsApp number
  | "is_dealer"; // another dealership's primary number

export type AddResult =
  | { ok: true; number: ExtraNumber }
  | { ok: false; reason: AddConflict };

/** Friendly per-conflict messages, shared by the admin API surfaces (route
 *  files can't export arbitrary consts, so the map lives here). */
export const CONFLICT_MESSAGES: Record<AddConflict, string> = {
  invalid_phone: "Enter a valid WhatsApp number.",
  already_extra_here:
    "That number is already an extra main number for this dealer.",
  already_extra_elsewhere:
    "That number is already an extra main number for another dealer.",
  is_operator:
    "That number belongs to an iTarang onboarding operator — it can't double as a dealer number.",
  is_salesperson:
    "That number belongs to a dealer's sales team member. Remove it from the team first.",
  is_own_number:
    "That is already this dealer's main WhatsApp number — no need to add it.",
  is_dealer: "That number is already another dealer's main WhatsApp number.",
};

/**
 * Check every identity a phone could already hold. The runTurn gate order
 * makes phone identity load-bearing: an operator (gate 1) or salesperson
 * (gate 2) match would win before the dealer fallback, and a primary dealer
 * match would shadow this table — so all of them are add-time conflicts.
 */
export async function findConflict(
  dealerCode: string,
  waPhone: string,
): Promise<AddConflict | null> {
  const variants = phoneVariants(waPhone);

  const [extra] = await db
    .select({ dealerCode: dealerExtraNumbers.dealer_code })
    .from(dealerExtraNumbers)
    .where(
      and(
        inArray(dealerExtraNumbers.wa_phone, variants),
        eq(dealerExtraNumbers.is_active, true),
      ),
    )
    .limit(1);
  if (extra) {
    return extra.dealerCode === dealerCode
      ? "already_extra_here"
      : "already_extra_elsewhere";
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

  const [sp] = await db
    .select({ id: dealerSalespersons.id })
    .from(dealerSalespersons)
    .where(
      and(
        inArray(dealerSalespersons.wa_phone, variants),
        eq(dealerSalespersons.is_active, true),
      ),
    )
    .limit(1);
  if (sp) return "is_salesperson";

  // A dealership's PRIMARY number — either surface it resolves through. Split
  // own vs. other so the admin gets an accurate message.
  const [app] = await db
    .select({ dealerCode: dealerOnboardingApplications.dealer_code })
    .from(dealerOnboardingApplications)
    .where(
      and(
        inArray(dealerOnboardingApplications.wa_phone, variants),
        eq(dealerOnboardingApplications.onboarding_status, "approved"),
        eq(dealerOnboardingApplications.dealer_account_status, "active"),
      ),
    )
    .limit(1);
  if (app) {
    return app.dealerCode === dealerCode ? "is_own_number" : "is_dealer";
  }

  const [dealerRow] = await db
    .select({ dealerCode: dealers.dealer_id })
    .from(dealers)
    .where(
      and(
        inArray(dealers.owner_phone, variants),
        eq(dealers.onboarding_status, "active"),
      ),
    )
    .limit(1);
  if (dealerRow) {
    return dealerRow.dealerCode === dealerCode ? "is_own_number" : "is_dealer";
  }

  return null;
}

export async function addExtraNumber(params: {
  dealerCode: string;
  /** Phone as typed — normalised here. */
  phone: string;
  displayName: string;
  addedBy: string | null;
  notes?: string | null;
}): Promise<AddResult> {
  const waPhone = toWaPhone(params.phone);
  if (!waPhone) return { ok: false, reason: "invalid_phone" };

  const conflict = await findConflict(params.dealerCode, waPhone);
  if (conflict) return { ok: false, reason: conflict };

  try {
    const [row] = await db
      .insert(dealerExtraNumbers)
      .values({
        dealer_code: params.dealerCode,
        wa_phone: waPhone,
        display_name: params.displayName.trim(),
        added_by: params.addedBy,
        added_via: "admin",
        notes: params.notes?.trim() || null,
      })
      .returning(RETURNING);
    return { ok: true, number: row };
  } catch (err: unknown) {
    // Race on dealer_extra_numbers_active_phone_key (unlocked check-then-insert
    // by design, like getOrCreateSession) — report it as the conflict it is.
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      return { ok: false, reason: "already_extra_elsewhere" };
    }
    throw err;
  }
}

/**
 * Deactivate (never delete): the number is freed for a future re-add (fresh
 * row) and the admin table keeps its history. Also resets the number's live
 * dealer-kind session to GREETING — after deactivation the console states are
 * unreachable for this phone, and without the reset its next message would
 * land in runOnboardingStates mid-DC_* state.
 */
export async function deactivateExtraNumber(params: {
  id: string;
  deactivatedBy: string | null;
}): Promise<ExtraNumber | null> {
  const [row] = await db
    .update(dealerExtraNumbers)
    .set({
      is_active: false,
      deactivated_at: new Date(),
      deactivated_by: params.deactivatedBy,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(dealerExtraNumbers.id, params.id),
        eq(dealerExtraNumbers.is_active, true),
      ),
    )
    .returning(RETURNING);
  if (!row) return null;

  try {
    await db
      .update(whatsappOnboardingSessions)
      .set({
        current_state: "GREETING",
        context: {},
        updated_at: new Date(),
      })
      .where(
        and(
          inArray(whatsappOnboardingSessions.wa_phone, phoneVariants(row.waPhone)),
          eq(whatsappOnboardingSessions.session_kind, "dealer"),
        ),
      );
  } catch (err) {
    // Session reset is best-effort — the row is already deactivated, and the
    // orchestrator's onboarding fallback tolerates unknown states poorly but
    // recoverably (the user can always send "hi").
    console.error("[team/extra-numbers] session reset failed:", err);
  }

  return row;
}

/** Rename / annotate an extra number (active or not). */
export async function updateExtraNumber(params: {
  id: string;
  displayName?: string;
  notes?: string | null;
}): Promise<ExtraNumber | null> {
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (params.displayName !== undefined) {
    set.display_name = params.displayName.trim();
  }
  if (params.notes !== undefined) set.notes = params.notes?.trim() || null;
  const [row] = await db
    .update(dealerExtraNumbers)
    .set(set)
    .where(eq(dealerExtraNumbers.id, params.id))
    .returning(RETURNING);
  return row ?? null;
}

/**
 * Re-activate a previously deactivated number. Re-runs the conflict matrix —
 * the phone may have become an operator / salesperson / another dealer's
 * number while inactive.
 */
export async function reactivateExtraNumber(params: {
  id: string;
}): Promise<AddResult | { ok: false; reason: "not_found" }> {
  const [existing] = await db
    .select(RETURNING)
    .from(dealerExtraNumbers)
    .where(eq(dealerExtraNumbers.id, params.id))
    .limit(1);
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.isActive) return { ok: true, number: existing };

  const conflict = await findConflict(existing.dealerCode, existing.waPhone);
  if (conflict) return { ok: false, reason: conflict };

  try {
    const [row] = await db
      .update(dealerExtraNumbers)
      .set({
        is_active: true,
        deactivated_at: null,
        deactivated_by: null,
        updated_at: new Date(),
      })
      .where(eq(dealerExtraNumbers.id, params.id))
      .returning(RETURNING);
    return row ? { ok: true, number: row } : { ok: false, reason: "not_found" };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      return { ok: false, reason: "already_extra_elsewhere" };
    }
    throw err;
  }
}
