/**
 * E-039 — Post-auction settlement service (BRD §6.1.7)
 *
 * Two operations:
 *   1. listSettlements({ caller_tenant_id, status?, page })
 *      Returns paginated auction_settlements rows whose seller_tenant_id
 *      matches the caller. Joins auction_lots for lot_code and nbfc_tenants
 *      for the winner display name.
 *
 *   2. patchSettlementStatus({ settlement_id, next_status, caller })
 *      Validates the linear transition payment_pending → in_transit → delivered,
 *      updates auction_settlements.status, on 'delivered' marks the linked
 *      nbfc_recovery_pipeline row's stage='resold' (when present), and writes
 *      an immutable nbfc_audit_log entry capturing before_state/after_state.
 */
import { db } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
import {
  auctionSettlements,
  auctionLots,
  nbfcTenants,
  nbfcAuditLog,
  accounts,
} from "@/lib/db/schema";

export type SettlementStatus =
  | "payment_pending"
  | "in_transit"
  | "delivered";

const ALLOWED_TRANSITIONS: Record<SettlementStatus, SettlementStatus[]> = {
  payment_pending: ["in_transit"],
  in_transit: ["delivered"],
  delivered: [],
};

export interface SettlementListItem {
  id: string;
  lot_id: string;
  /** Human-facing code — the id is a uuid nobody can read off a screen. */
  lot_code: string;
  final_price: number;
  winner_tenant_id: string;
  /** Set when a DEALER won (the normal case since the E-232 bidder re-point). */
  winner_dealer_id: string | null;
  winner_name: string;
  /**
   * Which kind of party the name belongs to.
   *
   * [FIX] This list used to inner-join `nbfc_tenants` on `winner_tenant_id` and
   * call the result the winner. On a dealer win that column carries the
   * SELLER's tenant — see the schema note on `auction_settlements` — so every
   * dealer win rendered the seller's own name back at them as the buyer. The
   * dealer's identity was in `winner_dealer_id` all along and no read path
   * selected it.
   */
  winner_kind: "dealer" | "nbfc";
  status: SettlementStatus;
  updated_at: string;
}

export interface ListSettlementsResult {
  items: SettlementListItem[];
  page: number;
  total: number;
}

const DEFAULT_PAGE_SIZE = 50;

function toNumber(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export interface ListSettlementsInput {
  caller_tenant_id: string;
  status?: SettlementStatus;
  page: number;
  pageSize?: number;
}

export async function listSettlements(
  input: ListSettlementsInput,
): Promise<ListSettlementsResult> {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const offset = (input.page - 1) * pageSize;

  const where = input.status
    ? and(
        eq(auctionSettlements.seller_tenant_id, input.caller_tenant_id),
        eq(auctionSettlements.status, input.status),
      )
    : eq(auctionSettlements.seller_tenant_id, input.caller_tenant_id);

  const rows = await db
    .select({
      id: auctionSettlements.id,
      lot_id: auctionSettlements.lot_id,
      lot_code: auctionLots.lot_code,
      final_price: auctionSettlements.final_price,
      winner_tenant_id: auctionSettlements.winner_tenant_id,
      winner_dealer_id: auctionSettlements.winner_dealer_id,
      status: auctionSettlements.status,
      updated_at: auctionSettlements.updated_at,
      tenant_name: nbfcTenants.display_name,
      dealer_name: accounts.business_entity_name,
    })
    .from(auctionSettlements)
    .leftJoin(auctionLots, eq(auctionLots.id, auctionSettlements.lot_id))
    .leftJoin(
      nbfcTenants,
      eq(nbfcTenants.id, auctionSettlements.winner_tenant_id),
    )
    // Dealer ids are application strings ("ACC-ITARANG-…"), not uuids, which is
    // why `winner_dealer_id` is varchar and why this is a separate join.
    .leftJoin(
      accounts,
      eq(accounts.id, auctionSettlements.winner_dealer_id),
    )
    .where(where)
    .orderBy(auctionSettlements.updated_at)
    .limit(pageSize)
    .offset(offset);

  const totalRows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(auctionSettlements)
    .where(where);
  const total = Number(totalRows[0]?.c ?? 0);

  const items: SettlementListItem[] = rows.map((r) => {
    const isDealerWin = r.winner_dealer_id != null;
    return {
      id: r.id,
      lot_id: r.lot_id,
      lot_code: r.lot_code ?? r.lot_id.slice(0, 8),
      final_price: toNumber(r.final_price),
      winner_tenant_id: r.winner_tenant_id,
      winner_dealer_id: r.winner_dealer_id ?? null,
      // Fall back to the raw id rather than an empty cell: an unresolvable
      // winner is a data problem someone needs to see, not a blank.
      winner_name: isDealerWin
        ? (r.dealer_name ?? r.winner_dealer_id ?? "")
        : (r.tenant_name ?? ""),
      winner_kind: isDealerWin ? "dealer" : "nbfc",
      status: r.status as SettlementStatus,
      updated_at: (r.updated_at as Date).toISOString(),
    };
  });

  return { items, page: input.page, total };
}

export interface PatchSettlementInput {
  settlement_id: string;
  next_status: SettlementStatus;
  caller_tenant_id: string;
  caller_user_id: string;
}

export interface PatchSettlementResult {
  id: string;
  status: SettlementStatus;
  updated_at: string;
}

export async function patchSettlementStatus(
  input: PatchSettlementInput,
): Promise<PatchSettlementResult> {
  // 1. Load current settlement.
  const rows = await db
    .select()
    .from(auctionSettlements)
    .where(eq(auctionSettlements.id, input.settlement_id))
    .limit(1);
  if (rows.length === 0) {
    throw new Error("NOT_FOUND: settlement not found");
  }
  const current = rows[0];

  // 2. Tenant scoping: caller must be the seller_tenant.
  if (current.seller_tenant_id !== input.caller_tenant_id) {
    throw new Error("FORBIDDEN: caller is not the seller tenant");
  }

  const fromStatus = current.status as SettlementStatus;
  const toStatus = input.next_status;

  // 3. Validate transition.
  const allowed = ALLOWED_TRANSITIONS[fromStatus] ?? [];
  if (!allowed.includes(toStatus)) {
    throw new Error(
      `BAD_REQUEST: invalid transition ${fromStatus} -> ${toStatus}`,
    );
  }

  // 3b. [E-252] Money before goods.
  //
  //     `payment_pending -> in_transit` was a bare status flip: the seller
  //     pressed a button and the settlement claimed the battery was on its way,
  //     with nothing anywhere recording that a rupee had moved. The status was
  //     the ONLY evidence of payment, and it was self-certified.
  //
  //     `paid_at` is now that evidence, and it is written by exactly two paths:
  //     a signature-verified gateway capture, or an explicit, attributed,
  //     reason-carrying offline record. Either is fine; neither is a click.
  if (toStatus === "in_transit" && !current.paid_at) {
    throw new Error(
      "CONFLICT: this settlement has not been paid — capture the payment, or " +
        "record an offline one against a reference, before dispatching",
    );
  }

  // 4. Apply update.
  const now = new Date();
  const [updated] = await db
    .update(auctionSettlements)
    .set({ status: toStatus, updated_at: now })
    .where(eq(auctionSettlements.id, current.id))
    .returning();

  // 5. On delivered: mark every recovery_pipeline row behind this lot 'resold'.
  //
  //    [E-232] This used to match `nbfc_recovery_pipeline.battery_serial` against
  //    `auction_lots.lot_code`. Those two values are never equal — createLot.ts
  //    derives lot_code as "LOT-" + the first 8 hex of the PIPELINE uuid, and
  //    never writes it into battery_serial — so the lookup returned zero rows
  //    every single time and no battery has ever actually been marked resold.
  //    It failed silently because the whole block was best-effort.
  //
  //    The join now runs on a real key. auction_lot_items (E-234) is the
  //    eventual source of truth for lot -> battery and it handles the
  //    multi-battery lots this BRD introduces; until it exists the single-battery
  //    path resolves through nbfc_recovery_pipeline.battery_id.
  if (toStatus === "delivered") {
    // The presence check has to happen in JS, not in the statement. Postgres
    // resolves table names at PARSE time, so a `to_regclass(...) IS NOT NULL`
    // guard inside a subquery does not save a statement that names a table the
    // database does not have — it still raises 42P01. Probe first, then choose
    // which statement to send.
    const probe = await db.execute(
      sql`SELECT to_regclass('public.auction_lot_items') AS t`,
    );
    const hasLotItems =
      (probe as unknown as Array<{ t: string | null }>)[0]?.t != null;

    let resoldCount = 0;
    if (hasLotItems) {
      const resoldRows = await db.execute(sql`
        UPDATE nbfc_recovery_pipeline p
           SET stage = 'resold', updated_at = ${now}
         WHERE p.tenant_id = ${input.caller_tenant_id}
           AND p.stage <> 'resold'
           AND p.battery_id IS NOT NULL
           AND p.battery_id IN (
                 SELECT i.battery_id
                   FROM auction_lot_items i
                  WHERE i.lot_id = ${current.lot_id}
               )
        RETURNING p.id
      `);
      resoldCount = (resoldRows as unknown as Array<unknown>).length;
    }

    if (resoldCount === 0) {
      // Single-battery lots, where the battery hangs off the pipeline row
      // rather than off a lot item.
      await db.execute(sql`
        UPDATE nbfc_recovery_pipeline p
           SET stage = 'resold', updated_at = ${now}
          FROM recovery_batteries rb
         WHERE rb.id = p.battery_id
           AND p.tenant_id = ${input.caller_tenant_id}
           AND p.stage <> 'resold'
           AND rb.state_code = 'lotted'
      `);
    }
  }

  // 6. Audit log — every PATCH is logged.
  await db.insert(nbfcAuditLog).values({
    tenant_id: input.caller_tenant_id,
    user_id: input.caller_user_id,
    action_type: "auction_settlement_status",
    action_id: current.id,
    before_state: {
      settlement_id: current.id,
      lot_id: current.lot_id,
      status: fromStatus,
    },
    after_state: {
      settlement_id: current.id,
      lot_id: current.lot_id,
      status: toStatus,
    },
  });

  return {
    id: updated.id,
    status: updated.status as SettlementStatus,
    updated_at: (updated.updated_at as Date).toISOString(),
  };
}
