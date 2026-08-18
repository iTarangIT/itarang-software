"use client";

/**
 * Draft lots waiting to be finished.
 *
 * Two kinds of draft land here. One the operator built in the composer. The
 * other was seeded automatically the moment a battery reached
 * `ready_for_auction` on the recovery board — `publishLotFromRecovery()` has
 * always created one lot per battery, and before the composer existed those
 * drafts had nowhere to go and nothing that could publish them. They are
 * labelled so nobody has to wonder where a lot they never made came from.
 */
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { nbfcFetch, formatINR } from "@/lib/auction/client";
import { ConditionChip } from "@/components/auction/AuctionPrimitives";

interface DraftLot {
  lot_id: string;
  lot_code: string;
  title: string | null;
  quantity: number;
  base_price: number;
  bid_increment: number;
  reserve_price: number | null;
  auction_type: string;
  created_at: string;
  auto_created: boolean;
  items: Array<{
    battery_id: string;
    serial: string;
    condition: string;
    item_price: number | null;
  }>;
}

export default function DraftList() {
  const qc = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["auction", "nbfc", "drafts"],
    queryFn: () =>
      nbfcFetch<{ items: DraftLot[]; total: number }>(
        "/api/nbfc/auction/drafts",
      ),
    refetchOnWindowFocus: true,
  });

  async function discard(lot: DraftLot) {
    const ok = await confirmDialog({
      title: `Discard ${lot.lot_code}?`,
      message: `${lot.quantity} batter${lot.quantity === 1 ? "y" : "ies"} will go back to ready and can be listed again. This cannot be undone.`,
      confirmText: "Discard",
      variant: "danger",
    });
    if (!ok) return;
    try {
      const r = await nbfcFetch<{ released: number }>(
        `/api/nbfc/auction/lots/${lot.lot_id}`,
        { method: "DELETE" },
      );
      toast.success(
        `${lot.lot_code} discarded — ${r.released} released back to ready`,
      );
      qc.invalidateQueries({ queryKey: ["auction"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  if (isLoading) {
    return (
      <div className="auc-grid">
        {[0, 1, 2].map((i) => (
          <div key={i} className="auc-skel-card">
            <div className="auc-skel" style={{ height: "1rem", width: "40%" }} />
            <div className="auc-skel" style={{ height: "2rem", width: "70%" }} />
            <div className="auc-skel" style={{ height: "1rem" }} />
          </div>
        ))}
      </div>
    );
  }

  if (isError) {
    return <div className="auc-inline-error">{(error as Error).message}</div>;
  }

  const drafts = data?.items ?? [];

  if (drafts.length === 0) {
    return (
      <div className="auc-empty">
        <p>No drafts waiting</p>
        <p className="auc-empty-hint">
          Compose a lot from batteries that have been inspected and are ready to
          sell. A draft is private until you publish it — nothing is announced
          and no dealer can see it.
        </p>
        <Link href="/nbfc/auction/new" className="auc-btn">
          Compose a lot
        </Link>
      </div>
    );
  }

  return (
    <div className="auc-grid">
      {drafts.map((lot) => (
        <article key={lot.lot_id} className="auc-card">
          <div className="auc-card-head" data-status="draft">
            <div style={{ minInlineSize: 0 }}>
              <Link
                href={`/nbfc/auction/compose/${lot.lot_id}`}
                className="auc-title"
                style={{ textDecoration: "none", display: "block" }}
              >
                {lot.title || lot.lot_code}
              </Link>
              <span className="auc-lotcode">{lot.lot_code}</span>
            </div>
            {lot.auto_created ? (
              <span className="auc-chip" data-tone="muted">
                from recovery
              </span>
            ) : null}
          </div>

          <div className="auc-card-body">
            <div className="auc-price-row">
              <div>
                <span className="auc-price-label">Opening price</span>
                <span className="auc-price">{formatINR(lot.base_price)}</span>
              </div>
              <div>
                <span className="auc-price-label">Batteries</span>
                <span className="auc-price">{lot.quantity}</span>
              </div>
            </div>

            <div className="auc-meta">
              {lot.items.slice(0, 4).map((i) => (
                <ConditionChip key={i.battery_id} condition={i.condition} />
              ))}
              {lot.items.length > 4 ? (
                <span className="auc-subtle">+{lot.items.length - 4}</span>
              ) : null}
            </div>

            <div className="auc-meta">
              <span className="auc-subtle">
                {lot.auction_type === "cash_refinance"
                  ? "cash + refinance"
                  : "cash"}
              </span>
              {lot.reserve_price != null ? (
                <span className="auc-subtle">
                  reserve {formatINR(lot.reserve_price)}
                </span>
              ) : null}
              <span className="auc-subtle">
                started {new Date(lot.created_at).toLocaleDateString("en-IN")}
              </span>
            </div>

            {lot.quantity === 0 ? (
              <span className="auc-chip" data-tone="warn">
                empty — cannot be published
              </span>
            ) : null}

            <div className="auc-linkrow" style={{ marginBlockStart: "0.75rem" }}>
              <Link
                href={`/nbfc/auction/compose/${lot.lot_id}`}
                className="auc-btn"
              >
                Continue
              </Link>
              <button
                type="button"
                className="auc-btn"
                data-variant="ghost"
                onClick={() => discard(lot)}
              >
                Discard
              </button>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
