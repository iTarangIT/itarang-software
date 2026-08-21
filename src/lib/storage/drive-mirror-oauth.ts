/**
 * E-255 — OAuth "Connect Google account" path for the Drive mirror.
 *
 * The service-account path needs domain-wide delegation, which lives under
 * Admin console → Security → Access and data control → API controls — a
 * section some Workspace editions do not expose at all (the itarang.com
 * console on 2026-08-19 showed only Alert center / Rules / Context-Aware
 * Access). This path needs nothing from the admin console: an admin clicks
 * "Connect Google account" on the settings page, signs in as the Workspace
 * user who should own the backup (it@itarang.com), grants Drive access once,
 * and the refresh token is kept in `app_settings` under `gdrive_mirror_oauth`.
 * From then on every upload is made as that user and lands in their My Drive
 * — exactly what delegation would have given, minus the console step.
 *
 * Needs an OAuth client (type "Web application") in the Google Cloud project
 * with the redirect URI `<NEXT_PUBLIC_APP_URL>/api/admin/settings/gdrive-mirror/oauth/callback`,
 * exposed as GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET. Keep the
 * consent screen's user type "Internal" so no Google verification is needed.
 *
 * Precedence in drive-mirror.ts: a stored OAuth token wins over the service
 * account; "Disconnect" on the settings page removes it and the SA path is
 * back in force.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";
import { google } from "googleapis";

import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";

const SETTINGS_KEY = "gdrive_mirror_oauth";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
export const OAUTH_SCOPES = [DRIVE_SCOPE, "https://www.googleapis.com/auth/userinfo.email"];

export type DriveOAuthGrant = {
  refresh_token: string;
  email: string | null;
  connected_at: string;
  connected_by: string | null;
};

export function isDriveOAuthClientConfigured(): boolean {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function driveOAuthRedirectUri(): string {
  const origin = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
  return `${origin}/api/admin/settings/gdrive-mirror/oauth/callback`;
}

export function driveOAuthClient() {
  if (!isDriveOAuthClientConfigured()) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not set.");
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID!,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
    driveOAuthRedirectUri(),
  );
}

// --- CSRF state ------------------------------------------------------------
// The state parameter is an HMAC-signed nonce so the callback can verify the
// round-trip without a server-side session store. Signed with the OAuth
// client secret (already a server secret) — no new env needed.

function stateSecret(): string {
  return process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
}

export function mintOAuthState(userId: string): string {
  const payload = `${userId}.${Date.now()}.${randomBytes(8).toString("hex")}`;
  const sig = createHmac("sha256", stateSecret()).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

/** Returns the user id the state was minted for, or null if invalid/expired (10 min). */
export function verifyOAuthState(state: string): string | null {
  try {
    const raw = Buffer.from(state, "base64url").toString();
    const idx = raw.lastIndexOf(".");
    if (idx < 0) return null;
    const payload = raw.slice(0, idx);
    const sig = raw.slice(idx + 1);
    const expected = createHmac("sha256", stateSecret()).update(payload).digest("hex");
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
    const [userId, ts] = payload.split(".");
    if (!userId || !ts || Date.now() - Number(ts) > 10 * 60_000) return null;
    return userId;
  } catch {
    return null;
  }
}

export function driveOAuthAuthUrl(userId: string): string {
  return driveOAuthClient().generateAuthUrl({
    access_type: "offline",
    // Force the consent screen so Google issues a refresh token even when the
    // user granted this app before (otherwise it is only sent the first time).
    prompt: "consent",
    include_granted_scopes: true,
    scope: OAUTH_SCOPES,
    state: mintOAuthState(userId),
  });
}

/** Exchange the callback code, learn who granted it, and store the grant. */
export async function completeDriveOAuth(code: string, connectedBy: string | null): Promise<DriveOAuthGrant> {
  const client = driveOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Remove the app under myaccount.google.com → Security → Third-party access and connect again.",
    );
  }
  // Google's consent screen lists each scope as its own checkbox. Leaving the
  // Drive one unticked is NOT an error: the exchange succeeds and returns a
  // grant carrying only openid/email, which every Drive call then rejects with
  // "Request had insufficient authentication scopes". Storing that token would
  // leave the settings page reporting a healthy connection over a credential
  // that cannot read the root folder, let alone upload — so refuse it here.
  const granted = (tokens.scope ?? "").split(" ").filter(Boolean);
  if (granted.length && !granted.includes(DRIVE_SCOPE)) {
    throw new Error(
      "That Google account was connected without Drive permission. Click 'Connect Google account' again and tick " +
        "\"See, edit, create and delete all of your Google Drive files\" on the consent screen.",
    );
  }

  client.setCredentials(tokens);
  let email: string | null = null;
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const me = await oauth2.userinfo.get();
    email = me.data.email ?? null;
  } catch {
    /* email is informational */
  }
  const grant: DriveOAuthGrant = {
    refresh_token: tokens.refresh_token,
    email,
    connected_at: new Date().toISOString(),
    connected_by: connectedBy,
  };
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ key: SETTINGS_KEY, value: grant, updated_at: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: grant, updated_at: now } });
  return grant;
}

export async function getDriveOAuthGrant(): Promise<DriveOAuthGrant | null> {
  try {
    const [row] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, SETTINGS_KEY))
      .limit(1);
    const v = row?.value as Partial<DriveOAuthGrant> | undefined;
    if (!v || typeof v.refresh_token !== "string" || !v.refresh_token) return null;
    return {
      refresh_token: v.refresh_token,
      email: typeof v.email === "string" ? v.email : null,
      connected_at: typeof v.connected_at === "string" ? v.connected_at : "",
      connected_by: typeof v.connected_by === "string" ? v.connected_by : null,
    };
  } catch {
    return null;
  }
}

/** Forget the grant (and best-effort revoke it at Google). */
export async function disconnectDriveOAuth(): Promise<void> {
  const grant = await getDriveOAuthGrant();
  await db.delete(appSettings).where(eq(appSettings.key, SETTINGS_KEY));
  if (grant && isDriveOAuthClientConfigured()) {
    try {
      await driveOAuthClient().revokeToken(grant.refresh_token);
    } catch {
      /* token may already be dead */
    }
  }
}

/** Public, non-secret view for the settings page. */
export async function describeDriveOAuth(): Promise<{
  clientConfigured: boolean;
  redirectUri: string;
  connected: boolean;
  email: string | null;
  connected_at: string | null;
}> {
  const grant = await getDriveOAuthGrant();
  return {
    clientConfigured: isDriveOAuthClientConfigured(),
    redirectUri: driveOAuthRedirectUri(),
    connected: Boolean(grant),
    email: grant?.email ?? null,
    connected_at: grant?.connected_at ?? null,
  };
}
