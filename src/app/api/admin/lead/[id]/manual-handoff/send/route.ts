/**
 * POST /api/admin/lead/[id]/manual-handoff/send
 *
 * BRD Addendum V0.2 §11.7 — admin sends the customer KYC to one or more
 * off-platform NBFCs by email (each gets a separate copy). Records a Manual
 * Handoff row (Sent state); the 24h nudge cron then chases until an outcome.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, manualHandoffs, productSelections } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { sendManualHandoffEmail } from "@/lib/email/sendManualHandoffEmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  emails: z
    .array(z.object({ email: z.string().email(), nbfc_name: z.string().max(200).optional() }))
    .min(1)
    .max(10),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdminAppUser();
    if (!admin) {
      return NextResponse.json({ success: false, error: { message: "Unauthorized" } }, { status: 403 });
    }
    const { id: leadId } = await params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ success: false, error: { message: "Invalid JSON" } }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: { message: "Validation", issues: parsed.error.issues } }, { status: 400 });
    }

    const [lead] = await db
      .select({ id: leads.id, name: leads.full_name, owner_name: leads.owner_name, phone: leads.phone })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) {
      return NextResponse.json({ success: false, error: { message: "Lead not found" } }, { status: 404 });
    }
    const [ps] = await db
      .select({ final_price: productSelections.final_price })
      .from(productSelections)
      .where(and(eq(productSelections.lead_id, leadId), eq(productSelections.payment_mode, "finance")))
      .orderBy(desc(productSelections.created_at))
      .limit(1);

    const customerName = lead.name || lead.owner_name || "Customer";
    const toEmails = parsed.data.emails.map((e) => e.email);

    let sent = 0;
    try {
      const r = await sendManualHandoffEmail({
        toEmails,
        leadId,
        customerName,
        customerPhone: lead.phone,
        loanAmount: ps?.final_price ?? null,
      });
      sent = r.sent;
    } catch (mailErr) {
      const msg = mailErr instanceof Error ? mailErr.message : String(mailErr);
      return NextResponse.json({ success: false, error: { message: `Email send failed: ${msg}` } }, { status: 502 });
    }

    const now = new Date();
    await db
      .insert(manualHandoffs)
      .values({
        lead_id: leadId,
        status: "sent",
        sent_to_emails: parsed.data.emails as unknown as Record<string, unknown>,
        sent_by: admin.id,
        sent_at: now,
        last_nudge_at: now,
        nudge_count: 0,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: manualHandoffs.lead_id,
        set: {
          status: "sent",
          sent_to_emails: parsed.data.emails as unknown as Record<string, unknown>,
          sent_by: admin.id,
          sent_at: now,
          last_nudge_at: now,
          nudge_count: 0,
          // clear any prior outcome on re-send
          outcome: null,
          winning_nbfc_name: null,
          declining_nbfcs: null,
          outcome_recorded_at: null,
          updated_at: now,
        },
      });

    return NextResponse.json({ success: true, data: { sent, status: "sent" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send manual handoff";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
