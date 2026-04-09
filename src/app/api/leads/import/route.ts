import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";

function normalizePhone(phone: string): string {
  let clean = phone.replace(/[^0-9]/g, "");
  if (clean.length === 12 && clean.startsWith("91")) clean = clean.substring(2);
  if (clean.length === 10) return `+91${clean}`;
  return phone.startsWith("+") ? phone : `+91${clean}`;
}

export async function POST(req: Request) {
  try {
    const { leads } = await req.json();

    if (!Array.isArray(leads) || leads.length === 0) {
      return NextResponse.json(
        { success: false, error: "No leads provided" },
        { status: 400 }
      );
    }

    let inserted = 0;
    let skipped = 0;

    for (const lead of leads) {
      if (!lead.phone) {
        skipped++;
        continue;
      }

      const phone = normalizePhone(String(lead.phone));

      // Check for duplicate by phone
      const existing = await db
        .select({ id: dealerLeads.id })
        .from(dealerLeads)
        .where(eq(dealerLeads.phone, phone))
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      await db.insert(dealerLeads).values({
        id: `DL-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        dealer_name: lead.dealer_name || null,
        phone,
        shop_name: lead.shop_name || null,
        location: lead.location || null,
        language: lead.language || "hindi",
        current_status: lead.current_status || "new",
        total_attempts: 0,
      });

      inserted++;
    }

    return NextResponse.json({ success: true, inserted, skipped });
  } catch (error: any) {
    console.error("[leads/import] Error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Import failed" },
      { status: 500 }
    );
  }
}
