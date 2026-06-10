/**
 * POST /api/nbfc/settings/wallet/auto-recharge/register
 *
 * Registers the NBFC's "iTarang Auto-Recharge Mandate" — §16.4 capability 3
 * (creditor-side NACH, iTarang as creditor on the NBFC-funded mandate). Delegates
 * to the WalletFundsProvider, persists the order/customer handles, and returns the
 * Checkout handoff the NBFC authorises (mirrors the borrower E-NACH managed flow).
 * The token is confirmed by /auto-recharge/confirm (localhost) or the wallet
 * webhook (prod). Role: nbfc_admin. NBFC-facing: no vendor name (§3.2).
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcTenants, nbfcLeadAssignments, nbfcWallets } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getOrCreateWallet } from "@/lib/nbfc/charging";
import { getWalletFundsProvider } from "@/lib/nbfc/wallet/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

const n = (v: string | number | null | undefined): number => {
  const x = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

async function resolveNbfcNumericId(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ nbfc_id: nbfcLeadAssignments.nbfc_id })
    .from(nbfcLeadAssignments)
    .where(eq(nbfcLeadAssignments.tenant_id, tenantId))
    .orderBy(desc(nbfcLeadAssignments.nbfc_id))
    .limit(1);
  return row?.nbfc_id ?? 0;
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: nbfc_admin required (role '${actor.role}')` },
        { status: 403 },
      );
    }

    const wallet = await getOrCreateWallet(actor.tenant_id);
    const [tenant] = await db
      .select({
        legal_name: nbfcTenants.nbfc_legal_name,
        display_name: nbfcTenants.display_name,
        contact_email: nbfcTenants.contact_email,
        grievance_helpline: nbfcTenants.grievance_helpline,
      })
      .from(nbfcTenants)
      .where(eq(nbfcTenants.id, actor.tenant_id))
      .limit(1);
    const nbfcId = await resolveNbfcNumericId(actor.tenant_id);

    // The provider requires a payer contact phone for a recurring mandate link.
    // The NBFC's published grievance helpline is the contact of record; keep only
    // its digits (Razorpay wants a bare number). Fail with an actionable message
    // rather than letting the provider reject with a cryptic "contact required".
    const contactPhone = (tenant?.grievance_helpline ?? "").replace(/\D/g, "").slice(-10);
    if (contactPhone.length < 10) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "BAD_REQUEST: a contact phone is required to register the auto-recharge mandate. Set the NBFC's grievance helpline (a 10-digit number) in Profile Settings first.",
        },
        { status: 400 },
      );
    }

    // Per-debit ceiling: the configured recharge amount with 1.5× headroom, else
    // a ₹1,00,000 default. In paise, hard-capped at ₹1,00,00,000.
    const rechargeRupees = n(wallet.auto_nach_recharge_amount);
    const baseRupees = rechargeRupees > 0 ? rechargeRupees * 1.5 : 100000;
    const maxAmountPaise = Math.min(Math.round(baseRupees * 100), 100_00_00_000);

    // Stable per-wallet mandate ref (no Date.now in scope concerns here — route).
    const mandateRef = `wallet-${actor.tenant_id}`.slice(0, 40);

    const provider = await getWalletFundsProvider();
    const reg = await provider.registerAutoRechargeMandate({
      tenantId: actor.tenant_id,
      nbfcId,
      legalName: tenant?.legal_name ?? tenant?.display_name ?? null,
      maxAmount: maxAmountPaise,
      mandateRef,
      contactEmail: tenant?.contact_email ?? null,
      contactPhone,
    });

    await db
      .update(nbfcWallets)
      .set({
        provider_name: provider.providerId,
        auto_nach_customer_id: reg.providerCustomerId ?? null,
        auto_nach_order_id: reg.providerOrderId ?? null,
        auto_nach_mandate_ref: mandateRef,
        auto_nach_status: "pending",
        updated_at: new Date(),
      })
      .where(eq(nbfcWallets.tenant_id, actor.tenant_id));

    return NextResponse.json({ ok: true, handoff: reg });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
