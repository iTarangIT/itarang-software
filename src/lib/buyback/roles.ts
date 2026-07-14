/**
 * Roles that act as iTarang staff on the buyback module.
 *
 * Kept dependency-free (no imports) on purpose: `src/middleware.ts` runs on
 * the Edge runtime and imports this constant directly to gate `/admin/buyback`
 * pages. `src/lib/buyback/auth.ts` imports `@/lib/db`, which cannot be pulled
 * into middleware — so this list lives here, and `auth.ts` re-exports it for
 * every existing import site.
 */
export const BUYBACK_ADMIN_ROLES = ["admin", "ceo", "business_head", "sales_head"] as const;
