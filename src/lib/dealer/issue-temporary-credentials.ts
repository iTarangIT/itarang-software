// E-214 — mint a fresh temporary password for an already-approved dealer and
// write it to BOTH password stores.
//
// Why this exists: only the bcrypt hash is kept, so the password issued at
// approval is unrecoverable. "Resend credentials" therefore cannot re-send — it
// must RESET. This is the one place that does it, so the admin console and any
// future re-issue path can't drift from the approve route's semantics.
//
// Both stores are written, in this order:
//   1. supabaseAdmin.auth.admin.updateUserById — authoritative for login
//   2. users.password_hash + must_change_password — matched on users.id, NEVER
//      on email (Supabase Auth lowercases emails while users.email is
//      mixed-case, so an email match silently updates zero rows).

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { generateTemporaryPassword } from "@/lib/auth/generateTemporaryPassword";
import { hashPassword } from "@/lib/auth/hashPassword";
import { supabaseAdmin } from "@/lib/supabase/admin";

export interface IssuedCredentials {
  ok: boolean;
  /** Plaintext — hand to the delivery channels, never persist or log it. */
  password?: string;
  error?: string;
}

export async function issueTemporaryCredentials(params: {
  /** Supabase auth user id — dealer_onboarding_applications.dealer_user_id. */
  authUserId: string;
}): Promise<IssuedCredentials> {
  const { authUserId } = params;
  if (!authUserId) return { ok: false, error: "missing_auth_user" };

  const password = generateTemporaryPassword();
  const passwordHash = await hashPassword(password);

  const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
    authUserId,
    { password },
  );
  if (authError) {
    return { ok: false, error: authError.message || "auth_update_failed" };
  }

  await db
    .update(users)
    .set({
      password_hash: passwordHash,
      must_change_password: true,
      updated_at: new Date(),
    })
    .where(eq(users.id, authUserId));

  return { ok: true, password };
}
