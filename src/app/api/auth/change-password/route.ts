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

    // update in your DB
    const newHash = await hashPassword(password);

    await db
      .update(users)
      .set({
        password_hash: newHash,
        must_change_password: false,
        updated_at: new Date(),
      })
      .where(eq(users.email, user.email!));

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