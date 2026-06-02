/**
 * NBFC prepaid wallet + configurable charging engine — BRD Addendum V0.2 §8.
 *
 * The deduction engine is admin-configured and NBFC-scoped. Each fired trigger
 * resolves the active catalogue items for that trigger (per-tenant overrides win
 * over global defaults) and posts a debit line to the prepaid wallet ledger,
 * decrementing the balance atomically. An empty wallet blocks initiation of new
 * chargeable activity (§8.1) — callers check `assertChargeable` first.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcChargeCatalogue, nbfcWalletLedger, nbfcWallets } from "@/lib/db/schema";

export type ChargeTrigger = "on_api_execution" | "on_vkyc_run" | "on_disbursal" | "monthly" | "manual";

/** 'YYYY-MM' for monthly GST-statement grouping. */
export function monthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const n = (v: string | number | null | undefined): number => {
  const x = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/** Returns the wallet row, creating a zero-balance one on first access. */
export async function getOrCreateWallet(tenantId: string) {
  const [existing] = await db.select().from(nbfcWallets).where(eq(nbfcWallets.tenant_id, tenantId)).limit(1);
  if (existing) return existing;
  await db.insert(nbfcWallets).values({ tenant_id: tenantId }).onConflictDoNothing({ target: nbfcWallets.tenant_id });
  const [row] = await db.select().from(nbfcWallets).where(eq(nbfcWallets.tenant_id, tenantId)).limit(1);
  return row;
}

/**
 * Active catalogue items for a trigger. Per-tenant items take precedence; only
 * if the tenant has none of its own for the trigger do global (tenant_id NULL)
 * defaults apply — so a tenant override replaces, not stacks with, the default.
 */
export async function getCatalogueItemsForTrigger(tenantId: string, trigger: ChargeTrigger) {
  const rows = await db
    .select()
    .from(nbfcChargeCatalogue)
    .where(
      and(
        eq(nbfcChargeCatalogue.trigger, trigger),
        eq(nbfcChargeCatalogue.status, "active"),
        or(eq(nbfcChargeCatalogue.tenant_id, tenantId), isNull(nbfcChargeCatalogue.tenant_id)),
      ),
    );
  const own = rows.filter((r) => r.tenant_id === tenantId);
  return own.length > 0 ? own : rows.filter((r) => r.tenant_id === null);
}

/** Total amount that a trigger would debit (sum of its catalogue items). */
export async function totalForTrigger(tenantId: string, trigger: ChargeTrigger): Promise<number> {
  const items = await getCatalogueItemsForTrigger(tenantId, trigger);
  return items.reduce((s, it) => s + n(it.amount), 0);
}

/**
 * §8.1 — blocks NEW chargeable activity when the prepaid balance can't cover
 * the trigger's total. Throws "INSUFFICIENT_FUNDS: …" for the caller to surface.
 */
export async function assertChargeable(tenantId: string, trigger: ChargeTrigger): Promise<void> {
  const total = await totalForTrigger(tenantId, trigger);
  if (total <= 0) return; // nothing configured → nothing to block
  const wallet = await getOrCreateWallet(tenantId);
  if (n(wallet.balance) < total) {
    throw new Error(
      `INSUFFICIENT_FUNDS: wallet balance ${n(wallet.balance)} < required ${total} for ${trigger}`,
    );
  }
}

export interface PostChargeArgs {
  tenantId: string;
  trigger: ChargeTrigger;
  leadId?: string | null;
  nbfcId?: number | null;
  postedBy?: string | null;
  /** Override the catalogue description (e.g. include the lead/run context). */
  descriptionSuffix?: string;
}

/**
 * Posts one debit ledger line per matching catalogue item and decrements the
 * balance atomically. Returns the created ledger row ids (empty if nothing
 * configured for the trigger). Does NOT itself block on balance — call
 * assertChargeable first where §8.1 requires an initiation gate.
 */
export async function postCharge(args: PostChargeArgs): Promise<string[]> {
  const items = await getCatalogueItemsForTrigger(args.tenantId, args.trigger);
  if (items.length === 0) return [];
  const month = monthKey();

  return db.transaction(async (tx) => {
    const [wallet] = await tx.select().from(nbfcWallets).where(eq(nbfcWallets.tenant_id, args.tenantId)).limit(1).for("update");
    let balance = wallet ? n(wallet.balance) : 0;
    if (!wallet) {
      await tx.insert(nbfcWallets).values({ tenant_id: args.tenantId }).onConflictDoNothing({ target: nbfcWallets.tenant_id });
    }
    const ids: string[] = [];
    for (const it of items) {
      const amt = n(it.amount);
      balance -= amt;
      const desc = args.descriptionSuffix ? `${it.name} — ${args.descriptionSuffix}` : it.name;
      const [led] = await tx
        .insert(nbfcWalletLedger)
        .values({
          tenant_id: args.tenantId,
          catalogue_item_id: it.id,
          kind: "charge",
          type: it.type,
          description: desc,
          amount: String(-amt),
          balance_after: String(balance),
          lead_id: args.leadId ?? null,
          nbfc_id: args.nbfcId ?? null,
          trigger_rule: args.trigger,
          posted_by: args.postedBy ?? null,
          month,
        })
        .returning({ id: nbfcWalletLedger.id });
      ids.push(led.id);
    }
    await tx
      .update(nbfcWallets)
      .set({ balance: String(balance), updated_at: new Date() })
      .where(eq(nbfcWallets.tenant_id, args.tenantId));
    return ids;
  });
}

export interface ManualDeductionArgs {
  tenantId: string;
  amount: number;
  description: string;
  postedBy?: string | null;
  leadId?: string | null;
}

/** §8.2 — admin one-off deduction (the catch-all). */
export async function postManualDeduction(args: ManualDeductionArgs): Promise<string> {
  const month = monthKey();
  return db.transaction(async (tx) => {
    const [wallet] = await tx.select().from(nbfcWallets).where(eq(nbfcWallets.tenant_id, args.tenantId)).limit(1).for("update");
    let balance = wallet ? n(wallet.balance) : 0;
    if (!wallet) {
      await tx.insert(nbfcWallets).values({ tenant_id: args.tenantId }).onConflictDoNothing({ target: nbfcWallets.tenant_id });
    }
    balance -= Math.abs(args.amount);
    const [led] = await tx
      .insert(nbfcWalletLedger)
      .values({
        tenant_id: args.tenantId,
        kind: "manual_deduction",
        description: args.description,
        amount: String(-Math.abs(args.amount)),
        balance_after: String(balance),
        lead_id: args.leadId ?? null,
        posted_by: args.postedBy ?? null,
        month,
      })
      .returning({ id: nbfcWalletLedger.id });
    await tx.update(nbfcWallets).set({ balance: String(balance), updated_at: new Date() }).where(eq(nbfcWallets.tenant_id, args.tenantId));
    return led.id;
  });
}

/** §8.1 — manual top-up / auto-NACH credit. */
export async function postTopup(args: { tenantId: string; amount: number; description: string; postedBy?: string | null }): Promise<string> {
  const month = monthKey();
  return db.transaction(async (tx) => {
    const [wallet] = await tx.select().from(nbfcWallets).where(eq(nbfcWallets.tenant_id, args.tenantId)).limit(1).for("update");
    let balance = wallet ? n(wallet.balance) : 0;
    if (!wallet) {
      await tx.insert(nbfcWallets).values({ tenant_id: args.tenantId }).onConflictDoNothing({ target: nbfcWallets.tenant_id });
    }
    balance += Math.abs(args.amount);
    const [led] = await tx
      .insert(nbfcWalletLedger)
      .values({
        tenant_id: args.tenantId,
        kind: "topup",
        description: args.description,
        amount: String(Math.abs(args.amount)),
        balance_after: String(balance),
        posted_by: args.postedBy ?? null,
        month,
      })
      .returning({ id: nbfcWalletLedger.id });
    await tx.update(nbfcWallets).set({ balance: String(balance), updated_at: new Date() }).where(eq(nbfcWallets.tenant_id, args.tenantId));
    return led.id;
  });
}

/** Aggregates a month's ledger by type for the GST statement (§8.2). */
export async function monthlyStatement(tenantId: string, month: string) {
  const lines = await db
    .select()
    .from(nbfcWalletLedger)
    .where(and(eq(nbfcWalletLedger.tenant_id, tenantId), eq(nbfcWalletLedger.month, month)))
    .orderBy(nbfcWalletLedger.created_at);
  const byType = new Map<string, number>();
  let debits = 0;
  let credits = 0;
  for (const l of lines) {
    const amt = n(l.amount);
    if (amt < 0) debits += -amt;
    else credits += amt;
    const key = l.type ?? l.kind;
    byType.set(key, (byType.get(key) ?? 0) + (amt < 0 ? -amt : 0));
  }
  return {
    month,
    lines,
    totals: { debits, credits, by_type: Object.fromEntries(byType) },
  };
}
