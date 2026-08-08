/**
 * POST /api/usage/heartbeat — "this person is still using the CRM".
 *
 * WHY NOT UNDER /api/operations/*. That namespace is the read console and every
 * route in it opens with requireOperationsAdmin(). This one is WRITTEN by every
 * signed-in person in the company; putting it there would mean a future blanket
 * guard on /api/operations/* silently killed collection.
 *
 * The user id and role come from the session cookie via requireAuth(), never
 * from the body — a client-asserted role would let an external opt into being
 * counted as staff.
 *
 * It never returns an error. The client fires this on a timer and ignores the
 * result; a 4xx/5xx would only produce console noise and retry storms while
 * changing nothing about what gets recorded.
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-utils";
import { isUuid } from "@/lib/operations/usageMath";
import { recordHeartbeat, usageHeartbeatEnabled } from "@/lib/usage/track";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Told once, the client stops pinging for OFF_CACHE_MS. */
const OFF = NextResponse.json({ ok: true, enabled: false });

export async function POST(req: Request) {
  // FLAG FIRST — before auth, before parsing, before any DB contact. When the
  // switch is off this route must be a constant function, so that shipping the
  // code and enabling the feature are genuinely separate events.
  if (!usageHeartbeatEnabled()) return OFF;

  try {
    const user = await requireAuth();
    const body = (await req.json().catch(() => null)) as {
      session_id?: unknown;
    } | null;

    // A malformed session id can only be a bug or a probe. Either way there is
    // nothing to record and nothing useful to say back.
    if (!isUuid(body?.session_id)) return NextResponse.json({ ok: true });

    await recordHeartbeat({
      userId: user.id,
      role: user.role,
      sessionId: body!.session_id as string,
    });
  } catch (e) {
    // Includes the unauthenticated case: requireAuth() redirects, which throws
    // NEXT_REDIRECT here. Logged, never surfaced.
    console.error("[usage] heartbeat route failed:", e);
  }

  // Identical response whatever happened — success, external role, unknown
  // session, or failure. A response that varied would turn this into an oracle
  // for probing which session ids exist.
  return NextResponse.json({ ok: true });
}
