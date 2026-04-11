import { NextRequest, NextResponse } from "next/server";
import { eq, and, desc } from "drizzle-orm";

import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 401 },
      );
    }

    const { data: profile } = await supabase
      .from("users")
      .select("role, dealer_id")
      .eq("id", user.id)
      .single();

    if (profile?.role !== "dealer" || !profile?.dealer_id) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(req.url);
    const unreadOnly = searchParams.get("unread") === "true";

    const conditions = [eq(notifications.dealer_id, profile.dealer_id)];
    if (unreadOnly) {
      conditions.push(eq(notifications.read, false));
    }

    const rows = await db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.created_at))
      .limit(50);

    const unreadCount = rows.filter((r) => !r.read).length;

    return NextResponse.json({
      success: true,
      data: {
        notifications: rows,
        unreadCount,
      },
    });
  } catch (error) {
    console.error("[Dealer Notifications] Error:", error);
    return NextResponse.json(
      { success: false, error: { message: "Failed to fetch notifications" } },
      { status: 500 },
    );
  }
}

// Mark notifications as read
export async function PATCH(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 401 },
      );
    }

    const { data: profile } = await supabase
      .from("users")
      .select("role, dealer_id")
      .eq("id", user.id)
      .single();

    if (profile?.role !== "dealer" || !profile?.dealer_id) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }

    const body = await req.json();
    const notificationIds: string[] = body.ids || [];

    if (notificationIds.length === 0) {
      // Mark all dealer notifications as read
      await db
        .update(notifications)
        .set({ read: true, read_at: new Date() })
        .where(
          and(
            eq(notifications.dealer_id, profile.dealer_id),
            eq(notifications.read, false),
          ),
        );
    } else {
      // Mark specific notifications as read
      for (const id of notificationIds) {
        await db
          .update(notifications)
          .set({ read: true, read_at: new Date() })
          .where(
            and(
              eq(notifications.id, id),
              eq(notifications.dealer_id, profile.dealer_id),
            ),
          );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Dealer Notifications] Error:", error);
    return NextResponse.json(
      { success: false, error: { message: "Failed to update notifications" } },
      { status: 500 },
    );
  }
}
