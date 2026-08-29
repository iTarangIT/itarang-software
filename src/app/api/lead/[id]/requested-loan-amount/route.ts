/**
 * GET / PATCH /api/lead/[id]/requested-loan-amount
 *
 * E-275 — "Up to how much loan do you want?" Asked on the product-selection
 * page BEFORE the lender list; `section-g-options` defaults its amount filter
 * to this value so the lenders shown are the ones whose loan_amount_max
 * covers the ask. Stored on `leads.requested_loan_amount`.
 *
 * Role: dealer, owning this lead. PATCH body: { amount: integer }.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import {
  getRequestedLoanAmount,
  setRequestedLoanAmount,
} from "@/lib/leads/requested-loan-amount";
import {
  MAX_REQUESTED_LOAN,
  MIN_REQUESTED_LOAN,
} from "@/lib/leads/requested-loan-amount-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  amount: z
    .number()
    .int("Loan amount must be a whole number")
    .min(MIN_REQUESTED_LOAN, "Loan amount is too small")
    .max(MAX_REQUESTED_LOAN, "Loan amount is too large"),
});

const bad = (message: string, status = 400) =>
  NextResponse.json({ success: false, error: { message } }, { status });

async function ownedLead(leadId: string) {
  const user = await requireRole(["dealer"]);
  const [lead] = await db
    .select({ id: leads.id, dealer_id: leads.dealer_id })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return { error: bad("Lead not found", 404) };
  if (lead.dealer_id !== user.dealer_id) return { error: bad("Access denied", 403) };
  return { lead };
}

function errorStatus(error: unknown): number {
  return typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : 500;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: leadId } = await params;
    const owned = await ownedLead(leadId);
    if ("error" in owned) return owned.error;
    const amount = await getRequestedLoanAmount(leadId);
    return NextResponse.json({ success: true, data: { amount } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load loan amount";
    return NextResponse.json({ success: false, error: { message } }, { status: errorStatus(error) });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: leadId } = await params;
    const owned = await ownedLead(leadId);
    if ("error" in owned) return owned.error;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return bad("Invalid JSON");
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return bad(parsed.error.issues[0]?.message ?? "Invalid loan amount");
    }

    await setRequestedLoanAmount(leadId, parsed.data.amount);
    return NextResponse.json({ success: true, data: { amount: parsed.data.amount } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save loan amount";
    console.error("[requested-loan-amount] error:", error);
    return NextResponse.json({ success: false, error: { message } }, { status: errorStatus(error) });
  }
}
