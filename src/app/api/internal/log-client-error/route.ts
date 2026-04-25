import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  let userEmail: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userEmail = user?.email ?? null;
  } catch {
    // Best-effort attribution — proceed even if Supabase isn't reachable.
  }

  console.error("[CLIENT ERROR]", {
    scope: body.scope ?? "unknown",
    pathname: body.pathname ?? null,
    userEmail,
    message: body.message ?? null,
    name: body.name ?? null,
    digest: body.digest ?? null,
    stack: body.stack ?? null,
    userAgent: body.userAgent ?? null,
    timestamp: body.timestamp ?? new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}
