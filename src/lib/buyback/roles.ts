/**
 * Roles that act as iTarang staff on the buyback module.
 *
 * Kept dependency-free (no imports) on purpose: `src/middleware.ts` runs on
 * the Edge runtime and imports this constant directly to gate `/admin/buyback`
 * pages. `src/lib/buyback/auth.ts` imports `@/lib/db`, which cannot be pulled
 * into middleware — so this list lives here, and `auth.ts` re-exports it for
 * every existing import site.
 */
export const BUYBACK_ADMIN_ROLES = ["admin", "ceo", "business_head", "sales_head", "partner"] as const;

export type BuybackAdminRole = (typeof BUYBACK_ADMIN_ROLES)[number];

/** Role strings arrive from the session as plain text; this is the typed check. */
export function isBuybackAdminRole(role: string | null | undefined): role is BuybackAdminRole {
  return typeof role === "string" && (BUYBACK_ADMIN_ROLES as readonly string[]).includes(role);
}
