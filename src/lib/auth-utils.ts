import { db } from "./db";
import { users } from "./db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "./supabase/server";
import { redirect } from "next/navigation";

// SECURITY: this projection exists so the queries below never do a bare
// `db.select()`. A bare select returns EVERY users column — including
// `password_hash` — and this result is returned verbatim by
// /api/user/profile, which AuthProvider then writes into sessionStorage.
// That put every logged-in user's bcrypt hash in the browser, readable by any
// XSS, any extension, any devtools screenshot. Add new columns here
// deliberately; never reintroduce `.select()` with no argument.
//
// `dealer_id` and `vendor_entity_id` MUST stay: requireDealer/requireVendor
// (src/lib/buyback/auth.ts) and the buyback notification routes read them off
// this result.
const USER_COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  dealer_id: users.dealer_id,
  vendor_entity_id: users.vendor_entity_id,
  phone: users.phone,
  avatar_url: users.avatar_url,
  is_active: users.is_active,
  must_change_password: users.must_change_password,
  created_at: users.created_at,
  updated_at: users.updated_at,
} as const;

/**
 * Like requireAuth, but also returns the Supabase auth user so callers that
 * need `app_metadata` (e.g. /api/user/profile's role sync) don't have to pay
 * for a second `auth.getUser()` round-trip.
 */
export async function requireAuthWithSupabaseUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  try {
    let dbUser =
      (
        await db
          .select(USER_COLUMNS)
          .from(users)
          .where(eq(users.id, user.id))
          .limit(1)
      )[0] ?? null;

    // Fallback by email in case older rows were created with a random UUID
    if (!dbUser && user.email) {
      dbUser =
        (
          await db
            .select(USER_COLUMNS)
            .from(users)
            .where(eq(users.email, user.email))
            .limit(1)
        )[0] ?? null;
    }

    if (!dbUser) {
      console.log(`[Auth] No DB user found for auth user: ${user.id} / ${user.email}`);
      // Same key set as the real row above (minus the DB-only timestamps), so
      // callers that read e.g. vendor_entity_id off this result see null
      // rather than undefined.
      return {
        dbUser: {
          id: user.id,
          name: user.email?.split("@")[0] || "User",
          email: user.email || "",
          role: "user",
          dealer_id: null,
          vendor_entity_id: null,
          phone: null,
          avatar_url: null,
          is_active: true,
          must_change_password: false,
        },
        authUser: user,
      };
    }

    return { dbUser, authUser: user };
  } catch (dbErr) {
    console.error("[Auth] Database error in requireAuth:", dbErr);
    throw dbErr;
  }
}

export async function requireAuth() {
  const { dbUser } = await requireAuthWithSupabaseUser();
  return dbUser;
}

/**
 * A role violation is a 403, not a server bug. withErrorHandler honours
 * `.status` on a thrown error (src/lib/api-utils.ts); without it every
 * wrong-role call surfaced as a 500 "Internal error" and was indistinguishable
 * from an outage in the client's error banner.
 */
class ForbiddenError extends Error {
  readonly status = 403;
}

export async function requireRole(roles: string[]) {
  const user = await requireAuth();

  if (!roles.includes(user.role)) {
    throw new ForbiddenError("Forbidden: Insufficient permissions");
  }

  return user;
}

// Roles allowed to upload, edit, write-off, or assign inventory.
// BRD: Ops Manager and Super Admin only — KYC officers cannot.
// `admin` is included as a transitional role until ops_manager / super_admin
// are formally seeded.
export const INVENTORY_ADMIN_ROLES = new Set([
  "admin",
  "ops_manager",
  "super_admin",
  "inventory_manager",
  "sales_head",
]);

export async function requireInventoryAdmin() {
  const user = await requireAuth();

  if (!INVENTORY_ADMIN_ROLES.has(user.role)) {
    throw new ForbiddenError("Forbidden: Inventory admin role required");
  }

  return user;
}