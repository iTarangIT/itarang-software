import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export async function POST(req: NextRequest) {
  let payload: { email?: unknown; password?: unknown };

  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid request body" },
      { status: 400 }
    );
  }

  const email =
    typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const password = typeof payload.password === "string" ? payload.password : "";

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json(
      { success: false, message: "Enter a valid email address" },
      { status: 400 }
    );
  }

  if (password.length < MIN_PASSWORD) {
    return NextResponse.json(
      {
        success: false,
        message: `Password must be at least ${MIN_PASSWORD} characters`,
      },
      { status: 400 }
    );
  }

  const { data: created, error: createError } =
    await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role: "dealer" },
    });

  if (createError || !created?.user) {
    const message = createError?.message || "Failed to create account";
    const alreadyRegistered =
      message.toLowerCase().includes("already") ||
      message.toLowerCase().includes("registered");

    return NextResponse.json(
      {
        success: false,
        message: alreadyRegistered
          ? "An account with this email already exists. Please log in instead."
          : message,
        alreadyRegistered,
      },
      { status: alreadyRegistered ? 409 : 400 }
    );
  }

  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) {
    return NextResponse.json(
      {
        success: false,
        message:
          "Account created, but automatic sign-in failed. Please log in to continue.",
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, email });
}
