import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-utils";

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { leadId, action, assignTo } = await req.json();

    if (action === "approve") {
      await db.update(dealerLeads)
        .set({ approved_by: user.name ?? user.email, current_status: "qualified" })
        .where(eq(dealerLeads.id, leadId));
    }

    if (action === "reject") {
      await db.update(dealerLeads)
        .set({ rejected_by: user.name ?? user.email, current_status: "disqualified" })
        .where(eq(dealerLeads.id, leadId));
    }

    if (action === "assign" && assignTo) {
      await db.update(dealerLeads)
        .set({ assigned_to: assignTo })
        .where(eq(dealerLeads.id, leadId));
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}