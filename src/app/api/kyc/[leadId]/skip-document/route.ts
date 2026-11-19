// E-392 — Battery Pool diagram 1, part 3. Skip a customer KYC document with a reason.
//
//   POST   { doc_type, reason } → record the skip (Aadhaar front/back and PAN refused)
//   DELETE ?doc_type=          → undo the skip
//
// Same gates as /upload-document: the caller's lead, a writer on it, and the
// dealer's KYC edits not locked.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { buildDealerEditLockMessage, isDealerKycEditsLocked } from "@/lib/kyc/admin-workflow";
import { requireLeadAccess } from "@/lib/auth/requireLeadAccess";
import { requireLeadWriter } from "@/lib/leads/actForDealerGuard";
import { clearSkip, recordSkip } from "@/lib/kyc/customer-doc-config";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const Body = z.object({
  doc_type: z.string().trim().min(1).max(50),
  reason: z.string().trim().max(500),
});

async function gates(req: NextRequest, leadId: string) {
  const leadGate = await requireLeadAccess(leadId);
  if (!leadGate.ok) return { error: leadGate.response } as const;
  const gate = await requireLeadWriter(leadId, req, leadGate.user);
  if (!gate.ok) return { error: gate.response } as const;
  if (await isDealerKycEditsLocked(leadId)) {
    return {
      error: NextResponse.json({ success: false, error: { message: buildDealerEditLockMessage() } }, { status: 409 }),
    } as const;
  }
  return { user: leadGate.user } as const;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params;
  const g = await gates(req, leadId);
  if ("error" in g) return g.error;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: { message: "Pick the document and write the reason." } }, { status: 400 });
  }
  const [me] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, g.user.id)).limit(1);
  try {
    const skip = await recordSkip({
      leadId,
      docType: parsed.data.doc_type,
      reason: parsed.data.reason,
      actor: { id: g.user.id, name: me?.name || me?.email || null },
      channel: "web",
    });
    return NextResponse.json({ success: true, data: { skip } });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: { message: err instanceof Error ? err.message : "Could not skip the document" } },
      { status: 400 },
    );
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params;
  const g = await gates(req, leadId);
  if ("error" in g) return g.error;
  const docType = new URL(req.url).searchParams.get("doc_type")?.trim();
  if (!docType) return NextResponse.json({ success: false, error: { message: "doc_type required" } }, { status: 400 });
  await clearSkip(leadId, docType);
  return NextResponse.json({ success: true });
}
