/**
 * "From whom → to whom" for a notification.
 *
 * Every row the hub writes records which party raised the event and which party
 * it is addressed to, so a recipient can see at a glance where a request came
 * from and what it is waiting on — "Bajaj Finance → iTarang Admin · Field
 * Investigation". That matters most for the hand-off chains, where the same
 * request legitimately bounces NBFC → Admin → Dealer → Admin → NBFC and the
 * title alone ("Documents updated") cannot say who is holding it.
 *
 * BEST-EFFORT BY CONTRACT. Provenance is decoration on top of the notification;
 * it must never be the reason an action fails. Every resolver here swallows its
 * errors and falls back to a generic label.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts, nbfcTenants, users } from "@/lib/db/schema";
import { getSessionUser } from "@/lib/nbfc/tenant";

export type PartyKind = "admin" | "dealer" | "nbfc" | "vendor" | "agent" | "customer" | "system";

export interface Party {
  /** Which side of the CRM this is — drives the icon/colour in the bell. */
  party: PartyKind;
  /** The organisation: "iTarang Admin", "Bajaj Finance", "Sharma Motors". */
  label: string;
  /** The person, when known: "R. Mehta (Credit Officer)". */
  actor?: string | null;
}

export const ADMIN_PARTY: Party = { party: "admin", label: "iTarang Admin" };
export const SYSTEM_PARTY: Party = { party: "system", label: "iTarang" };

export const adminParty = (actor?: string | null): Party => ({ ...ADMIN_PARTY, actor: actor ?? null });
export const dealerParty = (label: string, actor?: string | null): Party => ({
  party: "dealer",
  label: label || "Dealer",
  actor: actor ?? null,
});
export const nbfcParty = (label: string, actor?: string | null): Party => ({
  party: "nbfc",
  label: label || "NBFC partner",
  actor: actor ?? null,
});
export const vendorParty = (label: string, actor?: string | null): Party => ({
  party: "vendor",
  label: label || "Vendor",
  actor: actor ?? null,
});
export const customerParty = (label: string): Party => ({ party: "customer", label: label || "Customer" });
export const agentParty = (label: string): Party => ({ party: "agent", label: label || "Field agent" });

/** Roles that act as the iTarang side of a hand-off. */
const ADMIN_ROLES = new Set([
  "admin",
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  "sales_executive",
  "finance_controller",
  "inventory_manager",
  "service_engineer",
  "sales_order_manager",
  "risk_head",
]);

/** Human name for the display label of a dealer account id (accounts.id). */
export async function dealerLabel(dealerId: string | null | undefined): Promise<string> {
  if (!dealerId) return "Dealer";
  try {
    const [row] = await db
      .select({ name: accounts.business_entity_name })
      .from(accounts)
      .where(eq(accounts.id, dealerId))
      .limit(1);
    return row?.name || dealerId;
  } catch {
    return dealerId;
  }
}

/** Display name for an NBFC tenant id. */
export async function nbfcLabel(tenantId: string | null | undefined): Promise<string> {
  if (!tenantId) return "NBFC partner";
  try {
    const [row] = await db
      .select({ name: nbfcTenants.display_name })
      .from(nbfcTenants)
      .where(eq(nbfcTenants.id, tenantId))
      .limit(1);
    return row?.name || "NBFC partner";
  } catch {
    return "NBFC partner";
  }
}

/**
 * Who is acting on THIS request, resolved from the session.
 *
 * `tenantName` should be passed by NBFC routes that already resolved their
 * tenant (they all do, via `getCurrentTenant`) — it saves a query and is the
 * only way to name the NBFC correctly for a user who holds seats at more than
 * one tenant.
 */
export async function actingParty(hint?: {
  tenantId?: string | null;
  tenantName?: string | null;
}): Promise<Party> {
  try {
    const session = await getSessionUser();
    if (!session) return SYSTEM_PARTY;

    const [row] = await db
      .select({ name: users.name, role: users.role, dealer_id: users.dealer_id })
      .from(users)
      .where(eq(users.id, session.id))
      .limit(1);

    const actor = row?.name || session.email || null;
    const role = (row?.role || session.role || "").toLowerCase();

    if (hint?.tenantName) return nbfcParty(hint.tenantName, actor);
    if (role.startsWith("nbfc")) return nbfcParty(await nbfcLabel(hint?.tenantId), actor);
    if (role === "scrap_vendor") return vendorParty(await dealerLabel(row?.dealer_id), actor);
    if (role === "dealer") return dealerParty(await dealerLabel(row?.dealer_id), actor);
    if (ADMIN_ROLES.has(role)) return adminParty(actor);
    return { party: "system", label: "iTarang", actor };
  } catch {
    return SYSTEM_PARTY;
  }
}

/** One-line rendering used by the bell and the notifications page. */
export function provenanceLine(
  from: Party | null | undefined,
  to: Party | null | undefined,
  stage?: string | null,
): string | null {
  if (!from && !to) return null;
  const left = from ? from.label : "—";
  const right = to ? to.label : "—";
  const base = `${left} → ${right}`;
  return stage ? `${base} · ${stage}` : base;
}
