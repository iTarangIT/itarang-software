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
 *  · Roles are resolved to the state machine's two actors. The CRM has eleven
 *    roles; the deal state machine only cares "dealer or admin".
 */

import { and, eq } from "drizzle-orm";

import { requireRole } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { buybackRequests } from "@/lib/db/schema";
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

/** The caller must be a dealer, and must belong to an entity. */
export async function requireDealer(): Promise<BuybackActor> {
  const user = await requireRole(["dealer"]);

  if (!user.dealer_id) {
    // A dealer login with no entity cannot own anything.
    throw new ForbiddenError("Your login is not linked to a dealer account.");
  }

  return { id: user.id, role: "dealer", entityId: user.dealer_id };
}

/** The caller must be iTarang staff. */
export async function requireBuybackAdmin(): Promise<BuybackActor> {
  const user = await requireRole([...BUYBACK_ADMIN_ROLES]);
  return { id: user.id, role: "admin", entityId: null };
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
