/**
 * Provisioning the Supabase auth user behind a scrap vendor login (E-195).
 *
 * Extracted from POST /api/vendor/register so the ADMIN onboarding path
 * (E-222) uses the same one. Two copies would diverge on the orphan-adoption
 * rule below, and that rule is the difference between a vendor who can sign in
 * and one who is permanently told their account is "inactive".
 *
 * NOT ensureSupabaseUser from src/lib/nbfc/admin/activate-nbfc.ts — that one
 * hardcodes `role: "nbfc_partner"` in the auth metadata, and it does not adopt
 * orphans.
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { ValidationError } from "@/lib/buyback/errors";

/**
 * Create the vendor's Supabase auth user — or ADOPT an orphan.
 *
 * Callers MUST have already refused the email if a live `users` row exists for
 * it. Given that, if Supabase still refuses because an auth user exists, that
 * auth user is an ORPHAN: a login with no app-level `users` row, left behind by
 * a half-finished earlier sign-up (an admin-invited dealer that never
 * completed, a registration whose DB write failed). Nobody can use it — login
 * authenticates, the profile lookup finds nothing, and the app reports the
 * account "inactive". Rather than dead-ending on "email already registered", we
 * set the password on that auth user and reuse its id to create the rows that
 * were missing. Provisioning becomes idempotent: an email whose auth user
 * outlived its data can be onboarded again and self-heal.
 *
 * Safe by construction ONLY because of the caller's pre-check: an email WITH a
 * live `users` row never reaches here, so this never resets the password of a
 * working account.
 */
export async function createOrAdoptVendorAuthUser(
  email: string,
  password: string,
): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // MUST be set here. Middleware reads the role off the JWT's app_metadata and
    // falls back to user_metadata; the RDS role only reaches the JWT after
    // /api/user/profile has run once. Without this a brand-new vendor resolves to
    // "user" on their first navigation and gets bounced off /vendor-portal.
    user_metadata: { role: "scrap_vendor" },
  });
  if (data?.user?.id) return data.user.id;

  const alreadyRegistered = /already|exist/i.test(error?.message ?? "");
  const orphan = alreadyRegistered ? await findAuthUserByEmail(email) : null;
  if (!orphan) {
    throw new ValidationError(
      error?.message ?? "Could not create the login. Try again in a moment.",
    );
  }

  // Adopt: set the password + the vendor role, then hand back the existing id
  // so the DB rows are created against the same auth user.
  const { error: adoptError } = await supabaseAdmin.auth.admin.updateUserById(orphan.id, {
    password,
    email_confirm: true,
    user_metadata: { ...(orphan.user_metadata ?? {}), role: "scrap_vendor" },
    app_metadata: { ...(orphan.app_metadata ?? {}), role: "scrap_vendor" },
  });
  if (adoptError) throw new ValidationError(adoptError.message);
  return orphan.id;
}

/**
 * GoTrue admin has no by-email getter in supabase-js 2.99, so page listUsers().
 * Only ever called on the rare orphan-adopt path, so the linear scan is fine.
 */
export async function findAuthUserByEmail(email: string) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || data.users.length === 0) return null;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}
