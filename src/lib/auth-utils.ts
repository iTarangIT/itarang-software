import { db } from "./db";
import { users } from "./db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "./supabase/server";
import { redirect } from "next/navigation";

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
          .select()
          .from(users)
          .where(eq(users.id, user.id))
          .limit(1)
      )[0] ?? null;

    // Fallback by email in case older rows were created with a random UUID
    if (!dbUser && user.email) {
      dbUser =
        (
          await db
            .select()
            .from(users)
            .where(eq(users.email, user.email))
            .limit(1)
        )[0] ?? null;
    }

    if (!dbUser) {
      console.log(`[Auth] No DB user found for auth user: ${user.id} / ${user.email}`);
      return {
        dbUser: {
          id: user.id,
          name: user.email?.split("@")[0] || "User",
          email: user.email || "",
          role: "user",
          dealer_id: null,
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

export async function requireRole(roles: string[]) {
  const user = await requireAuth();

  if (!roles.includes(user.role)) {
    throw new Error("Forbidden: Insufficient permissions");
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
    throw new Error("Forbidden: Inventory admin role required");
  }

  return user;
}