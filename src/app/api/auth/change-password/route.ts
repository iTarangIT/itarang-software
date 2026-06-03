import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword } from "@/lib/auth/hashPassword";

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json();

    if (!password) {
      return NextResponse.json(
        { success: false, message: "Password required" },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    // get current logged-in user
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      return NextResponse.json(
        { success: false, message: "Unauthorized" },
        { status: 401 }
      );
    }

    // update password in Supabase
    const { error: updateError } = await supabase.auth.updateUser({
      password,
    });

    if (updateError) {
      return NextResponse.json(
        { success: false, message: updateError.message },
        { status: 500 }
      );
    }

    // update in your DB. Match by id, NOT email: Supabase Auth lowercases the
    // email while the app's users row may hold it mixed-case (from onboarding),
    // and Postgres `=` is case-sensitive — matching by email updated 0 rows, so
    // must_change_password never cleared and every login looped back here. The
    // row's id IS the Supabase auth user id (set at activation).
    const newHash = await hashPassword(password);

    const updated = await db
      .update(users)
      .set({
        password_hash: newHash,
        must_change_password: false,
        updated_at: new Date(),
      })
      .where(eq(users.id, user.id))
      .returning({ id: users.id });

    if (updated.length === 0) {
      console.error(`CHANGE PASSWORD: no users row for auth id ${user.id} (${user.email})`);
      return NextResponse.json(
        { success: false, message: "Account record not found." },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (err: any) {
    console.error("CHANGE PASSWORD ERROR:", err);

    return NextResponse.json(
      {
        success: false,
        message: err.message || "Failed to update password",
      },
      { status: 500 }
    );
  }
}