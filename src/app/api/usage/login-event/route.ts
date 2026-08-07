/**
 * POST /api/usage/login-event — record that somebody signed in.
 *
 * WHY THIS EXISTS AS A ROUTE AT ALL. The live login is a CLIENT component
 * (src/app/(auth)/login/page.tsx) calling supabase.auth.signInWithPassword() in
 * the browser, so there is no server code path that runs exactly once per
 * sign-in. (src/app/(auth)/login/actions.ts looks like one, but nothing imports
 * it — it is dead.) Hooking /api/user/profile instead would be wrong:
 * AuthProvider calls it on every mount, so navigations would count as logins.
 *
 * WHY NOT UNDER /api/operations/*. Every route in that tree opens with
 * requireOperationsAdmin(). This one must be callable by every signed-in role,
 * and putting it there would mean a future blanket guard on /api/operations/*
 * silently killed collection.
 *
 * There is NO REQUEST BODY. The user id comes from the session cookie via
 * requireAuth(), so a caller cannot forge a login for somebody else.
 *
 * It never returns an error to the browser and never throws. The caller fires it
 * with keepalive and ignores the result; a login must not fail, or even look
 * like it failed, because analytics did.
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-utils";
import { recordLoginEvent } from "@/lib/usage/track";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const user = await requireAuth();
    await recordLoginEvent({ id: user.id, role: user.role });
  } catch (e) {
    // Includes the unauthenticated case: requireAuth() redirects, which throws
    // here. Nothing is written, and the browser is told nothing either way.
    console.error("[usage] login-event route failed:", e);
  }

  // 204 unconditionally — success, kill switch, external role and failure are
  // deliberately indistinguishable to the client. There is nothing it could do
  // differently, and a 4xx/5xx would surface in the console during a login.
  return new NextResponse(null, { status: 204 });
}
