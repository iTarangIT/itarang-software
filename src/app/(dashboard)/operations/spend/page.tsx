import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCount, formatIst, formatMinutesAgo } from "@/lib/operations/format";
import { formatINR } from "@/lib/currency";
import { getSpendView, type VendorRow } from "@/lib/operations/spend";

import { AutoRefresh } from "../_components/AutoRefresh";

export const metadata = { title: "Spend · Ops Console" };

/**
 * Vendor usage and spend — two independent views that should reconcile.
 *
 *   metered — what we consumed, from our own tables
 *   billed  — what we were actually invoiced (expense_submissions, tech bucket)
 *
 * The gap between them IS the product. A vendor with metered usage and no
 * invoice is on a prepaid plan or about to surprise us; a vendor with an
 * invoice and no metered usage is something nobody is measuring. Neither shows
 * up if you only look at one column, which is why both windows are trailing 30
 * days rather than the more natural month-to-date.
 */

/** Percentages, formatted with an explicit sign — a delta needs its direction. */
function delta(pct: number | null) {
  if (pct == null) return <span className="text-ink-muted">—</span>;
  const rounded = Math.round(pct * 10) / 10;
  const tone =
    rounded > 15 ? "text-danger" : rounded < -15 ? "text-success" : "text-ink-muted";
  return (
    <span className={`tabular-nums ${tone}`}>
      {rounded > 0 ? "+" : ""}
      {rounded}%
    </span>
  );
}

function BurnChart({
  burn,
  currentMonth,
}: {
  burn: { month: string; paise: number }[];
  currentMonth: string;
}) {
  if (burn.length === 0) {
    return <p className="text-sm text-ink-muted">No invoiced tech spend yet.</p>;
  }
  // Oldest-to-newest reads left to right like every other time axis.
  const series = [...burn].reverse();
  const max = Math.max(...series.map((b) => b.paise), 1);

  return (
    <div className="flex items-end gap-2">
      {series.map((month) => {
        // Compare against the real current month, not "is it the last bar".
        // A month with no invoices produces no row, so the newest bar is
        // often a finished month — shading it as partial would misread it.
        const partial = month.month === currentMonth;
        return (
          <div key={month.month} className="flex flex-1 flex-col items-center gap-1">
            <span className="text-[10px] tabular-nums text-ink-muted">
              {formatINR(month.paise)}
            </span>
            <div
              className={`w-full rounded-t ${partial ? "bg-brand-sky/50" : "bg-brand-navy"}`}
              style={{ height: `${Math.max((month.paise / max) * 80, 2)}px` }}
              title={partial ? `${month.month} (month in progress)` : month.month}
            />
            <span className="text-[10px] text-ink-muted">{month.month.slice(2)}</span>
          </div>
        );
      })}
    </div>
  );
}

function ReconRow({ vendor }: { vendor: VendorRow }) {
  const hasMeteredCost = vendor.metered_paise != null;
  // Only comparable when both halves are money. A call count against an invoice
  // is not a variance, and rendering one would invent a number.
  const gap =
    hasMeteredCost && vendor.billed_paise > 0
      ? ((vendor.metered_paise! - vendor.billed_paise) / vendor.billed_paise) * 100
      : null;

  return (
    <tr className="border-b border-border/60 align-top last:border-0">
      <td className="py-2.5 pr-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-ink">{vendor.label}</span>
          {!vendor.matched && (
            <Badge variant="muted" title="No canonical vendor matched this invoice name">
              unmatched
            </Badge>
          )}
        </div>
        {vendor.entities.length > 0 && (
          <div
            className="mt-0.5 max-w-[24rem] truncate text-[11px] text-ink-muted"
            title={vendor.entities.join(", ")}
          >
            {vendor.entities.join(", ")}
          </div>
        )}
      </td>
      <td className="py-2.5 pr-3 text-right tabular-nums">
        {hasMeteredCost ? (
          <span className="text-ink">{formatINR(vendor.metered_paise!)}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        )}
      </td>
      <td className="py-2.5 pr-3 text-right tabular-nums text-ink-muted">
        {vendor.metered_calls == null ? "—" : formatCount(vendor.metered_calls)}
      </td>
      <td className="py-2.5 pr-3 text-right tabular-nums text-ink">
        {vendor.billed_paise > 0 ? formatINR(vendor.billed_paise) : "—"}
      </td>
      <td className="py-2.5 pr-3 text-right">{delta(gap)}</td>
      <td className="py-2.5 text-[11px] text-ink-muted">
        {vendor.metered_from ?? "not metered"}
      </td>
    </tr>
  );
}

export default async function OperationsSpendPage() {
  let view: Awaited<ReturnType<typeof getSpendView>>;
  try {
    view = await getSpendView();
  } catch (e) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-danger">Spend unavailable</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-ink-muted">
          <pre className="overflow-x-auto rounded-lg bg-bg p-3 text-[11px] text-ink">
            {e instanceof Error ? e.message : String(e)}
          </pre>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-muted">
          Metered and billed are independent reads over the same trailing 30
          days. They are meant to agree — the gap is the signal.
        </p>
        <AutoRefresh intervalMs={60_000} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Monthly tech burn</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Approved invoices in the tech bucket, by invoice date. The last bar
              is the month in progress.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <BurnChart burn={view.burn} currentMonth={view.current_month} />
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <span className="text-ink-muted">
                MTD{" "}
                <span className="font-semibold text-ink">
                  {formatINR(view.billed_tech_mtd_paise)}
                </span>
              </span>
              <span className="text-ink-muted">
                Last 30d{" "}
                <span className="font-semibold text-ink">
                  {formatINR(view.billed_tech_30d_paise)}
                </span>
              </span>
              <span className="text-ink-muted">
                MoM (complete months) {delta(view.mom_delta_pct)}
              </span>
            </div>
            {view.tech_filter_column === null && (
              <p className="text-[11px] text-warning">
                Neither <code>bucket</code> nor <code>department</code> exists on
                this database, so no invoice can be classified as tech spend.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Vendor credit balances</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Polled from the vendor. Nothing else in the CRM watches these, so a
              burn-out is otherwise invisible until calls start failing.
            </p>
          </CardHeader>
          <CardContent>
            {view.credits.length === 0 ? (
              <p className="text-sm text-ink-muted">
                No credit data yet. The <code>vendor.elevenlabs</code> collector
                needs <code>ELEVENLABS_API_KEY</code> set; without it the
                collector returns nothing rather than failing.
              </p>
            ) : (
              <div className="space-y-3">
                {view.credits.map((credit) => (
                  <div
                    key={credit.vendor}
                    className="rounded-lg border border-border p-3"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-ink">
                        {credit.label}
                      </span>
                      <span className="text-lg font-semibold tabular-nums text-ink">
                        {credit.remaining == null
                          ? "—"
                          : `${formatCount(credit.remaining)} cr`}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg">
                      <div
                        className={
                          (credit.used_pct ?? 0) >= 93
                            ? "h-full bg-danger"
                            : (credit.used_pct ?? 0) >= 80
                              ? "h-full bg-warning"
                              : "h-full bg-success"
                        }
                        style={{ width: `${Math.min(credit.used_pct ?? 0, 100)}%` }}
                      />
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-ink-muted">
                      <span>{credit.used_pct ?? 0}% of quota used</span>
                      {credit.tier && <span>tier {credit.tier}</span>}
                      {credit.reset_at && (
                        <span>resets {formatIst(credit.reset_at)}</span>
                      )}
                      <span className="ml-auto">
                        {formatMinutesAgo(credit.age_minutes)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Metered vs billed (30 days)</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              AI call cost is metered in INR paise and directly comparable.
              Everything else is a volume count — we hold no rate card for those
              vendors, so a cost there would be invented.
            </p>
          </div>
          <Badge variant="muted">
            AI {formatINR(view.ai_cost_30d_paise)} · {formatCount(view.ai_calls_30d)}{" "}
            calls
          </Badge>
        </CardHeader>
        <CardContent>
          {view.vendors.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Nothing metered or billed in the last 30 days.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    <th className="py-2 pr-3">Vendor</th>
                    <th className="py-2 pr-3 text-right">Metered cost</th>
                    <th className="py-2 pr-3 text-right">Metered volume</th>
                    <th className="py-2 pr-3 text-right">Billed</th>
                    <th className="py-2 pr-3 text-right">Gap</th>
                    <th className="py-2">Metered from</th>
                  </tr>
                </thead>
                <tbody>
                  {view.vendors.map((vendor) => (
                    <ReconRow key={vendor.id} vendor={vendor} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
