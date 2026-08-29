/**
 * Auth + entity scoping for the buyback module.
 *
 * Two rules encoded here:
 *
 *  · A dealer only ever sees their own entity's requests. The lookup is scoped
 *    by dealer_entity_id in the WHERE clause — not fetched-then-checked — and a
 *    miss is a 404, never a 403. A 403 would confirm the request exists, which
 *    lets one dealer enumerate another's request IDs (BRD M01 AC).
 *
 *  · The same rule for a scrap vendor: scoped to the threads routed to THEM,
 *    404 on a miss. A vendor must not be able to discover that a deal exists,
 *    let alone which dealer it came from.
 *
 *  · Roles are resolved to the state machine's three actors. The CRM has a dozen
 *    roles; the deal state machine only cares "dealer, admin or vendor".
 */

import { and, eq } from "drizzle-orm";

import { requireRole } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { buybackRequests } from "@/lib/db/schema";
import { capabilitiesFor } from "@/lib/dealer/dealer-capabilities";
import { resolveDealerTypeForUser } from "@/lib/dealer/dealer-type-runtime";
import { ForbiddenError, NotFoundError } from "./errors";
import { BUYBACK_ADMIN_ROLES } from "./roles";
import type { ActorRole } from "./state-machine";

/**
 * Roles that act as iTarang staff on the buyback portal: `admin`, `ceo`,
 * `business_head`, and `sales_head`.
 *
 * `sales_head` is here because they are the people who actually run the desk —
 * reviewing requests, haggling with dealers, routing to vendors. `business_head`
 * has read/oversight access to the admin queue and detail pages. The state
 * machine only knows two actors ("dealer" or "admin"), and every role in this
 * list resolves to "admin" for its purposes.
 *
 * THIS LIST IS THE GATE. The sidebar (src/components/layout/sidebar.tsx,
 * BUYBACK_ADMIN_SECTION) shows the buyback menu to exactly these roles, so the
 * two must be changed together — a link a role can see but not open is worse than
 * no link at all.
 *
 * It is also who gets the in-portal notifications: a duplicate-photo fraud alert,
 * a signed agreement, a vendor's response. Adding a role here starts sending them
 * that traffic, which is the intent.
 *
 * The list itself lives in `./roles` (dependency-free, Edge-safe) — imported
 * above AND re-exported here so every existing import site
 * (`from "@/lib/buyback/auth"`) keeps working. NOTE it must be a real import,
 * not `export { X } from "./roles"`: a bare re-export does NOT create a local
 * binding, so requireBuybackAdmin's use of it below threw a ReferenceError at
 * runtime and 500'd every admin buyback API call.
 */
export { BUYBACK_ADMIN_ROLES };

export interface BuybackActor {
  id: string;
  role: ActorRole;
  /** accounts.id — set for dealers, null for admins. */
  entityId: string | null;
}

/**
 * The caller must be a dealer, must belong to an entity, and must be a dealer
 * TYPE that trades in old batteries.
 *
 * This function is the first statement of every one of the ~21 dealer buyback
 * routes, which makes it the single choke point for the E-202 capability gate.
 * Putting the check here rather than in each route is what guarantees the
 * server refusal matches what the sidebar shows: a NEW-battery dealer sees no
 * buyback menu, and typing the URL gets them a 403 rather than a working page
 * the UI merely declined to link to. The header above says the same thing about
 * BUYBACK_ADMIN_ROLES — "a link a role can see but not open is worse than no
 * link at all"; this is the inverse, and just as important.
 *
 * Cost is one indexed lookup on dealers.dealer_id (UNIQUE) for an approved
 * dealer — see resolveDealerTypeForUser.
 */
export async function requireDealer(): Promise<BuybackActor> {
  const user = await requireRole(["dealer"]);

  if (!user.dealer_id) {
    // A dealer login with no entity cannot own anything.
    throw new ForbiddenError("Your login is not linked to a dealer account.");
  }

  const dealerType = await resolveDealerTypeForUser(user);
  if (!capabilitiesFor(dealerType).buyback) {
    throw new ForbiddenError(
      "Battery buyback is only available to scrap and new+scrap dealers.",
    );
  }

  return { id: user.id, role: "dealer", entityId: user.dealer_id };
}

/** The caller must be iTarang staff. */
export async function requireBuybackAdmin(): Promise<BuybackActor> {
  const user = await requireRole([...BUYBACK_ADMIN_ROLES]);
  return { id: user.id, role: "admin", entityId: null };
}

/**
 * The caller must be a scrap vendor, and must belong to a vendor account (E-195).
 *
 * `vendor_entity_id`, never `dealer_id` — a vendor login has no dealer_id at
 * all, and reading one would silently scope them to nothing (or, worse, to a
 * dealer). The value is an accounts.id, the same id scrap_vendors.entity_id
 * points at, which is what lets a route resolve "which vendor is this?" with a
 * single join.
 *
 * Being ACTIVE is deliberately NOT checked here. A PENDING vendor can log in
 * and look at their (empty) dashboard the moment they sign up — that is the
 * point of self-serve. What they cannot do is receive work, and that is
 * enforced where it belongs: listRoutableVendors() only ever routes a deal to
 * a vendor whose business_entity_roles row is ACTIVE, so a stranger who signs
 * up has nothing to see until an admin activates them.
 */
export async function requireVendor(): Promise<BuybackActor> {
  const user = await requireRole(["scrap_vendor"]);

  if (!user.vendor_entity_id) {
    throw new ForbiddenError("Your login is not linked to a vendor account.");
  }

  return { id: user.id, role: "vendor", entityId: user.vendor_entity_id };
}

/**
 * Load a request the CALLING DEALER owns, or 404.
 *
 * The entity id is part of the query, so there is no window in which we hold
 * another dealer's row in memory and rely on remembering to check it.
 */
export async function loadOwnRequest(actor: BuybackActor, requestId: string) {
  if (actor.role !== "dealer" || !actor.entityId) {
    throw new ForbiddenError("Dealer scope required.");
  }

  const [row] = await db
    .select()
    .from(buybackRequests)
    .where(
      and(
        eq(buybackRequests.id, requestId),
        eq(buybackRequests.dealer_entity_id, actor.entityId),
      ),
    )
    .limit(1);

  // Someone else's request is indistinguishable from a non-existent one.
  if (!row) throw new NotFoundError("Request not found.");

  return row;
}

/**
 * Resolve a CRM user to the buyback portal role its notifications belong to, or
 * null if the user has no buyback surface. The dozen CRM roles collapse to the
 * three the notification centre cares about — the same collapse requireDealer /
 * requireBuybackAdmin / requireVendor do, but without throwing (a shared bell
 * must degrade quietly for a role that simply has no buyback feed).
 */
export function portalRoleOf(
  role: string | null | undefined,
  hasDealerId: boolean,
  hasVendorId: boolean,
): ActorRole | null {
  const r = (role ?? "").toLowerCase();
  if (r === "dealer") return hasDealerId ? "dealer" : null;
  if (r === "scrap_vendor") return hasVendorId ? "vendor" : null;
  if ((BUYBACK_ADMIN_ROLES as readonly string[]).includes(r)) return "admin";
  return null;
}

/** Load any request as an admin, or 404. */
export async function loadAnyRequest(requestId: string) {
  const [row] = await db
    .select()
    .from(buybackRequests)
    .where(eq(buybackRequests.id, requestId))
    .limit(1);

  if (!row) throw new NotFoundError("Request not found.");
  return row;
}
