/**
 * E-292 — issuing a refurbisher partner their portal login.
 *
 * A near-copy of src/lib/buyback/vendor-credentials.ts (E-223), which is the
 * shape every partner login in this app follows: mint the password FIRST,
 * refuse an email that is already someone else's login, create-or-adopt the
 * Supabase auth user OUTSIDE any transaction, upsert the `users` row with the
 * link column (refurbisher_id) and must_change_password, then email — and
 * treat a bounced email as a STATE (credential_dispatch_failed, retry from the
 * directory), never as an exception that loses the partner.
 */
import { eq } from "drizzle-orm";

import { generatePortalPassword } from "@/lib/auth/generatePortalPassword";
import { hashPassword } from "@/lib/auth/hashPassword";
import { db } from "@/lib/db";
import { refurbisherPortalCredentials, refurbishers, users } from "@/lib/db/schema";
import { createOrAdoptAuthUser } from "@/lib/buyback/vendor-auth";
import { sendRefurbisherWelcomeEmail } from "@/lib/email/sendRefurbisherWelcomeEmail";

export interface IssueRefurbisherCredentialsResult {
  dispatched: boolean;
  /** Masked — returned to the browser and written to logs. */
  dispatchedTo: string;
  error?: string;
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 1) return email;
  return `${email.slice(0, 2)}${"*".repeat(Math.max(2, at - 2))}${email.slice(at)}`;
}

export async function issueRefurbisherCredentials(
  refurbisher_id: string,
  { loginUrl }: { loginUrl: string },
): Promise<IssueRefurbisherCredentialsResult> {
  const [ref] = await db.select().from(refurbishers).where(eq(refurbishers.id, refurbisher_id)).limit(1);
  if (!ref) throw new Error("NOT_FOUND: refurbisher not found");
  const email = ref.email.trim().toLowerCase();
  const contactName = ref.contact_name?.trim() || ref.name;

  const password = generatePortalPassword();

  // Refuse before provisioning if this email is already someone ELSE's login.
  const [existingLogin] = await db
    .select({ id: users.id, refurbisher_id: users.refurbisher_id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existingLogin && existingLogin.refurbisher_id !== refurbisher_id) {
    throw new Error("CONFLICT: an account already exists for this email address");
  }

  const authUserId = await createOrAdoptAuthUser(email, password, "refurbisher");

  const [credential] = await db
    .insert(refurbisherPortalCredentials)
    .values({ refurbisher_id, supabase_user_id: authUserId, email, dispatch_status: "pending" })
    .returning({ id: refurbisherPortalCredentials.id });

  const hash = await hashPassword(password);
  await db
    .insert(users)
    .values({
      id: authUserId,
      email,
      name: contactName,
      role: "refurbisher",
      refurbisher_id,
      password_hash: hash,
      must_change_password: true,
      is_active: true,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { email, name: contactName, role: "refurbisher", refurbisher_id, password_hash: hash, must_change_password: true, is_active: true, updated_at: new Date() },
    });

  try {
    await sendRefurbisherWelcomeEmail({
      toEmail: email,
      contactName,
      refurbisherName: ref.name,
      loginEmail: email,
      password,
      loginUrl,
      supportEmail: process.env.VENDOR_SUPPORT_EMAIL || process.env.DEALER_SUPPORT_EMAIL || "support@itarang.com",
      supportPhone: process.env.SUPPORT_PHONE || "+91-8076841497",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "The credentials email could not be sent.";
    await db.update(refurbisherPortalCredentials).set({ dispatch_status: "credential_dispatch_failed", last_error: message }).where(eq(refurbisherPortalCredentials.id, credential.id));
    await db.update(refurbishers).set({ credential_dispatch_status: "credential_dispatch_failed", credential_last_error: message, updated_at: new Date() }).where(eq(refurbishers.id, refurbisher_id));
    return { dispatched: false, dispatchedTo: maskEmail(email), error: message };
  }

  const now = new Date();
  await db.update(refurbisherPortalCredentials).set({ dispatch_status: "dispatched", email_dispatched_at: now }).where(eq(refurbisherPortalCredentials.id, credential.id));
  await db.update(refurbishers).set({ credential_dispatch_status: "dispatched", credential_dispatched_at: now, credential_last_error: null, updated_at: now }).where(eq(refurbishers.id, refurbisher_id));
  return { dispatched: true, dispatchedTo: maskEmail(email) };
}
