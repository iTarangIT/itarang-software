import { db } from "./db";
import { users } from "./db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "./supabase/server";
import { redirect } from "next/navigation";

export async function requireAuth() {
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
        id: user.id,
        name: user.email?.split("@")[0] || "User",
        email: user.email || "",
        role: "user",
        dealer_id: null,
      };
    }

    return dbUser;
  } catch (dbErr) {
    console.error("[Auth] Database error in requireAuth:", dbErr);
    throw dbErr;
  }
}

export async function requireRole(roles: string[]) {
  const user = await requireAuth();

  if (!roles.includes(user.role)) {
    throw new Error("Forbidden: Insufficient permissions");
  }

  return user;
}