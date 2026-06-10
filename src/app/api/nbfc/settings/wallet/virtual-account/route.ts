/**
 * POST /api/nbfc/settings/wallet/virtual-account
 *
 * Issues (or refreshes) the NBFC's "iTarang Virtual Account" — §16.4 capability 1
 * (per-NBFC funds-collection routing). Delegates to the active WalletFundsProvider
 * (Smart Collect VA under the hood) and persists the display fields on the wallet
 * so the NBFC can pay in via UPI/NEFT and have it auto-credited by the inflow
 * webhook. Role: nbfc_admin. NBFC-facing: never names the vendor (§3.2).
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

/** Best-effort numeric NBFC id for the tenant (correlation only; tenant_id is the key). */
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
      .select({ legal_name: nbfcTenants.nbfc_legal_name, display_name: nbfcTenants.display_name })
      .from(nbfcTenants)
      .where(eq(nbfcTenants.id, actor.tenant_id))
      .limit(1);
    const nbfcId = await resolveNbfcNumericId(actor.tenant_id);

    const provider = await getWalletFundsProvider();
    const account = await provider.ensureCollectionAccount({
      tenantId: actor.tenant_id,
      nbfcId,
      legalName: tenant?.legal_name ?? tenant?.display_name ?? null,
    });

    await db
      .update(nbfcWallets)
      .set({
        provider_name: provider.providerId,
        va_provider_account_id: account.providerAccountId,
        va_upi_vpa: account.upiVpa ?? null,
        va_account_number: account.accountNumber ?? null,
        va_ifsc: account.ifsc ?? null,
        va_status: account.rawStatus ?? null,
        updated_at: new Date(),
      })
      .where(eq(nbfcWallets.tenant_id, actor.tenant_id));

    return NextResponse.json({
      ok: true,
      virtual_account: {
        upi_vpa: account.upiVpa,
        account_number: account.accountNumber,
        ifsc: account.ifsc,
        status: account.rawStatus,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
