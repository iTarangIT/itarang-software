/**
 * E-292 — who is the refurbisher on this request?
 *
 * The refurbisher portal follows the VENDOR pattern (cookie session +
 * users.role + a link column), not the NBFC's header-based resolveActor: a
 * refurbisher is one login for one partner, with no tenant seats and no
 * per-tenant role to resolve.
 *
 * `refurbisher_id` is what scopes every read and write: loadLot(id,
 * {refurbisher_id}) never returns another partner's lot, and getLot(…,
 * "refurbisher") never returns the money.
 */
import { requireRole } from "@/lib/auth-utils";
import { isNextRedirectError } from "@/lib/api-utils";

export interface RefurbisherActor {
  user_id: string;
  refurbisher_id: string;
  email: string;
  name: string;
}

class ForbiddenError extends Error {
  readonly status = 403;
}

export async function requireRefurbisher(): Promise<RefurbisherActor> {
  const user = await requireRole(["refurbisher"]);
  const rid = (user as { refurbisher_id?: string | null }).refurbisher_id ?? null;
  if (!rid) throw new ForbiddenError("FORBIDDEN: your login is not linked to a refurbisher");
  return { user_id: user.id, refurbisher_id: rid, email: user.email, name: user.name };
}

/** Map an auth/route error to an HTTP status the refurbisher routes can return. */
export function refurbisherStatusFromError(e: unknown): number {
  if (isNextRedirectError(e)) throw e; // no session — let Next redirect to /login
  const status = (e as { status?: number })?.status;
  if (typeof status === "number") return status;
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN") || /Forbidden/i.test(msg)) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}
