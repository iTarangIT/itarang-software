// [E-102] GET /api/admin/dealers/{dealerId}
//
// Canonical dealers-table read endpoint. The path parameter `dealerId` is
// dual-keyed by design (BRD Resolution D, AC3): callers may pass either the
// integer primary key (e.g. "42") or the human-readable VARCHAR dealer_id
// (e.g. "DLR-001"). The response always returns BOTH fields (`id` numeric,
// `dealerId` string|null) — even when dealerId is null pre-activation (AC4).
//
// Note on FK migrations: this unit only DEFINES the canonical dealers table.
// Updating consumer tables (inventory.dealer_id, leads.dealer_id, etc.) to
// reference dealers.id is intentionally out of scope for E-102 — those are
// separate migration units (G-04 follow-up).

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealers } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/requireAdmin";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

// A pure-numeric path param means look up by INT PK; anything else (e.g.
// "DLR-001") routes to the VARCHAR dealer_id lookup. We deliberately accept
// both rather than splitting into separate routes because BRD Section D.1
// says dealer_id is the only public-facing identifier in URLs / file paths.
function isNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}

export async function GET(_req: NextRequest, context: RouteContext) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  try {
    const { dealerId } = await context.params;

    if (!dealerId) {
      return NextResponse.json(
        { success: false, message: "Missing dealerId path parameter" },
        { status: 400 },
      );
    }

    const [row] = isNumericId(dealerId)
      ? await db
          .select()
          .from(dealers)
          .where(eq(dealers.id, Number(dealerId)))
          .limit(1)
      : await db
          .select()
          .from(dealers)
          .where(eq(dealers.dealer_id, dealerId))
          .limit(1);

    if (!row) {
      return NextResponse.json(
        { success: false, message: "Dealer not found" },
        { status: 404 },
      );
    }

    // AC4: response body always contains both `id` (number) and `dealerId`
    // (string|null) — never collapse the pair, even pre-activation when the
    // human-readable code hasn't been generated yet.
    return NextResponse.json({
      success: true,
      data: {
        id: row.id,
        dealerId: row.dealer_id ?? null,
        companyName: row.company_name,
        companyType: row.company_type,
        gstNumber: row.gst_number,
        panNumber: row.pan_number,
        registeredAddress: row.registered_address,
        bankName: row.bank_name,
        // Per BRD non-functional requirement: bank_account_number is stored
        // encrypted at rest. Service-layer decryption is intentionally NOT
        // applied here yet — admin detail panels should fetch via the
        // dedicated finance endpoint that performs the decrypt + audit log.
        bankIfsc: row.bank_ifsc,
        bankBeneficiary: row.bank_beneficiary,
        bankBranch: row.bank_branch,
        bankAccountType: row.bank_account_type,
        ownerName: row.owner_name,
        ownerPhone: row.owner_phone,
        ownerEmail: row.owner_email,
        financeEnabled: row.finance_enabled,
        onboardingStatus: row.onboarding_status,
        applicationId: row.application_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        activatedAt: row.activated_at,
      },
    });
  } catch (error: any) {
    console.error("ADMIN DEALERS GET ERROR:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch dealer" },
      { status: 500 },
    );
  }
}
