// Shared-secret bearer auth for the Discord bot API (/api/bot/*).
//
// The bot sends `Authorization: Bearer <BOT_API_KEY>` on every request. We
// compare it against the server-side BOT_API_KEY env var with a timing-safe
// check (same posture as the Bolna/Razorpay webhook verifiers). This is the
// ONLY auth on /api/bot/* — these routes never read a Supabase session, so the
// dashboard's role middleware is irrelevant here.
//
// Fail-closed: if BOT_API_KEY is not configured on the server, every request is
// rejected (503). There is intentionally NO dev bypass — set BOT_API_KEY in
// .env.local for local work.

import { NextResponse } from "next/server";
import crypto from "crypto";
import { withErrorHandler } from "@/lib/api-utils";

function deny(message: string, status: number): NextResponse {
  return NextResponse.json(
    { success: false, error: { message }, timestamp: new Date().toISOString() },
    { status },
  );
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on unequal lengths; short-circuit but keep the
  // comparison constant-time for the equal-length case.
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Returns a 401/503 response when the request is not an authenticated bot call,
// or null when the key is valid and the handler may proceed.
export function checkBotKey(req: Request): NextResponse | null {
  const expected = process.env.BOT_API_KEY;
  if (!expected) {
    return deny("Bot API is not configured on the server", 503);
  }

  const header = req.headers.get("authorization") || "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token || !timingSafeEqualStr(token, expected)) {
    return deny("Invalid or missing bot API key", 401);
  }
  return null;
}

// Wraps a route handler with (1) the bot-key gate and (2) the standard
// withErrorHandler envelope (Zod → 400, redirect re-throw, DB error sanitizing).
export function withBotAuth(
  handler: (req: Request, ctx?: any) => Promise<Response> | Response,
) {
  return withErrorHandler(async (req: Request, ctx?: any) => {
    const denied = checkBotKey(req);
    if (denied) return denied;
    return handler(req, ctx);
  });
}
