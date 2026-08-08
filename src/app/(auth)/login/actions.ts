"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function login(formData: FormData) {
  const supabase = await createClient();

  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");

  if (!email || !password) {
    redirect("/login?error=Email and password are required");
  }

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    console.error("[LOGIN] Supabase login failed:", error.message);
    redirect("/login?error=Could not authenticate user");
  }

  const matchedUsers = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  const appUser = matchedUsers[0];

  if (!appUser) {
    console.error("[LOGIN] Local app user not found for:", email);
    redirect("/login?error=User record not found");
  }

  if (!appUser.is_active) {
    console.error("[LOGIN] Inactive user:", email);
    redirect("/login?error=User is inactive");
  }

  console.log("[LOGIN] User found:", {
    email: appUser.email,
    role: appUser.role,
    must_change_password: appUser.must_change_password,
    is_active: appUser.is_active,
    dealer_id: appUser.dealer_id,
  });

  // NOTE: nothing imports this file — the live login is the client component in
  // ./page.tsx. No usage-tracking call is needed here either way: sign-ins are
  // recorded server-side in /api/user/profile, keyed off Supabase's own
  // last_sign_in_at, and every post-login destination calls it. See
  // src/lib/usage/track.ts.

  revalidatePath("/", "layout");

  if (appUser.must_change_password) {
    redirect("/change-password");
  }

  if (appUser.role === "dealer") {
    redirect("/dealer-portal");
  }

  if (appUser.role === "scrap_vendor") {
    redirect("/vendor-portal");
  }

  if (appUser.role === "admin") {
    redirect("/admin");
  }

  // The "onboarding" role has no dashboard — it exists to land staff straight
  // in the dealer-onboarding workspace (New / My Drafts chooser).
  if (appUser.role === "onboarding") {
    redirect("/dealer-onboarding");
  }

  // The Ops Console monitoring login. Note this chain is much shorter than the
  // one in login/page.tsx — ceo, sales_head and the rest are handled there and
  // fall through to "/" here, which middleware then bounces to the right
  // dashboard. Adding the branch here anyway so `operations` does not depend on
  // that bounce.
  if (appUser.role === "operations") {
    redirect("/operations");
  }

  redirect("/");
}

export async function signup(formData: FormData) {
  const supabase = await createClient();

  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");

  if (!email || !password) {
    redirect("/login?error=Email and password are required");
  }

  const { error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) {
    console.error("[SIGNUP] Supabase signup failed:", error.message);
    redirect("/login?error=Could not authenticate user");
  }

  revalidatePath("/", "layout");
  redirect("/");
}