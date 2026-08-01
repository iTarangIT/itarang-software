/**
 * Issuing a scrap vendor their portal login (E-223).
 *
 * THE ONE WRITER. Both the create route (POST /api/admin/buyback/vendors) and
 * the retry route (POST .../vendors/:entityId/credentials) call this and
 * nothing else, so there is exactly one place that decides when a vendor
 * becomes routable.
 *
 * WHY THIS IS ALSO THE ACTIVATION GATE. business_entity_roles.status flips to
 * ACTIVE here, on the SUCCESS of the credentials email, and nowhere else on the
 * admin-onboarding path. That is the product rule: a vendor is onboarded when
 * they can actually get in. A vendor marked ACTIVE who never received a
 * password would be routed a dealer's battery lot — with its pickup city on it
 * — and have no way to respond, which reads to the desk as an unresponsive
 * vendor rather than as a bounced email.
 *
 * FAILURE IS A STATE, NOT AN EXCEPTION. Ordering is copied from NBFC
 * activation, including its discipline: if the email throws, the credential row
 * is stamped `credential_dispatch_failed` with the mailer's own sentence and
 * the role STAYS PENDING. The vendor exists, their documents are on file, and
 * an admin can retry — but they are not routable. This function returns that
 * outcome rather than throwing, because the caller has already created the
 * vendor and rolling that back would lose the documents too.
 */

import { and, eq } from "drizzle-orm";

import { generatePortalPassword } from "@/lib/auth/generatePortalPassword";
import { hashPassword } from "@/lib/auth/hashPassword";
import { db } from "@/lib/db";
import { businessEntityRoles, users, vendorPortalCredentials } from "@/lib/db/schema";
import { sendVendorWelcomeEmail } from "@/lib/email/sendVendorWelcomeEmail";
import { HttpError } from "./errors";
import { createOrAdoptVendorAuthUser } from "./vendor-auth";

export interface IssueVendorCredentialsInput {
  /** accounts.id of the vendor. */
  entityId: string;
  /** Where the credentials go, and the login ID itself. */
  email: string;
  contactName: string;
  vendorName: string;
}

export interface IssueVendorCredentialsResult {
  dispatched: boolean;
  /** Masked — this string is returned to the browser and written to logs. */
  dispatchedTo: string;
  /** The mailer's own sentence when `dispatched` is false. */
  error?: string;
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.slice(0, 2)}${"*".repeat(Math.max(2, local.length - 2))}${domain}`;
}

export async function issueVendorCredentials(
  input: IssueVendorCredentialsInput,
  { loginUrl }: { loginUrl: string },
): Promise<IssueVendorCredentialsResult> {
  const email = input.email.trim().toLowerCase();

  // Generated BEFORE the Supabase call so the copy we email is exactly the one
  // Supabase was given. Generating it twice, or reading it back, is how an
  // account ends up with a password nobody has.
  const password = generatePortalPassword();

  // Refuse before provisioning if this email is already someone else's login.
  // Without this check createOrAdoptVendorAuthUser would reset a WORKING
  // account's password — its orphan-adoption rule is only safe because callers
  // do this first.
  const [existingLogin] = await db
    .select({ id: users.id, vendor_entity_id: users.vendor_entity_id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existingLogin && existingLogin.vendor_entity_id !== input.entityId) {
    throw new HttpError("An account already exists for this email address.", 409);
  }

  // Outside any transaction: the auth user is the one thing here that cannot be
  // rolled back. If the writes below fail we are left with an orphan auth user,
  // which the adopt path heals on retry. The reverse — DB rows with no way to
  // sign in — nobody can heal.
  const authUserId = await createOrAdoptVendorAuthUser(email, password);

  const [credential] = await db
    .insert(vendorPortalCredentials)
    .values({
      entity_id: input.entityId,
      supabase_user_id: authUserId,
      dispatch_status: "pending",
    })
    .returning({ id: vendorPortalCredentials.id });

  // Upsert, not insert: a retry after a bounced email runs this again, and a
  // second run must reset the password on the SAME row rather than collide.
  await db
    .insert(users)
    .values({
      id: authUserId,
      email,
      name: input.contactName,
      role: "scrap_vendor",
      // The link E-195 exists for. NOT dealer_id — see that migration.
      vendor_entity_id: input.entityId,
      password_hash: await hashPassword(password),
      // Unlike self-registration (where the vendor chose it), iTarang minted
      // this password and emailed it in plaintext. The change-password modal is
      // already wired app-wide off this flag.
      must_change_password: true,
      is_active: true,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email,
        name: input.contactName,
        role: "scrap_vendor",
        vendor_entity_id: input.entityId,
        password_hash: await hashPassword(password),
        must_change_password: true,
        is_active: true,
        updated_at: new Date(),
      },
    });

  try {
    await sendVendorWelcomeEmail({
      toEmail: email,
      contactName: input.contactName,
      vendorName: input.vendorName,
      vendorCode: input.entityId,
      loginEmail: email,
      password,
      loginUrl,
      supportEmail:
        process.env.VENDOR_SUPPORT_EMAIL ||
        process.env.DEALER_SUPPORT_EMAIL ||
        "support@itarang.com",
      supportPhone: process.env.SUPPORT_PHONE || "+91-8076841497",
    });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "The credentials email could not be sent.";

    await db
      .update(vendorPortalCredentials)
      .set({ dispatch_status: "credential_dispatch_failed", last_error: message })
      .where(eq(vendorPortalCredentials.id, credential.id));

    // Role stays PENDING — see the file header. Not thrown: the vendor and
    // their documents are real and must survive this.
    return { dispatched: false, dispatchedTo: maskEmail(email), error: message };
  }

  await db
    .update(vendorPortalCredentials)
    .set({ dispatch_status: "dispatched", email_dispatched_at: new Date() })
    .where(eq(vendorPortalCredentials.id, credential.id));

  // The activation itself, and the last thing to happen: everything above must
  // have worked for this vendor to start receiving dealers' battery lots.
  await db
    .update(businessEntityRoles)
    .set({ status: "ACTIVE", updated_at: new Date() })
    .where(
      and(
        eq(businessEntityRoles.entity_id, input.entityId),
        eq(businessEntityRoles.role, "SCRAP_VENDOR"),
      ),
    );

  return { dispatched: true, dispatchedTo: maskEmail(email) };
}
