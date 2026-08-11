import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCount, formatIst, formatMinutesAgo } from "@/lib/operations/format";
import { formatINR } from "@/lib/currency";
import {
  getSpendBreakdown,
  getSpendView,
  type BreakdownRow,
  type VendorRow,
} from "@/lib/operations/spend";
import { parseSpendWindow, TRAILING_30 } from "@/lib/operations/spendWindow";

import { AutoRefresh } from "../_components/AutoRefresh";
import { SpendWindowSelector } from "../_components/SpendWindowSelector";

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
  selected,
}: {
  burn: { month: string; paise: number; invoices: number }[];
  currentMonth: string;
  selected: string;
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
        // The series is gap-filled now, so the newest bar IS the current month
        // — but the check stays correct either way and costs nothing.
        const partial = month.month === currentMonth;
        const isSelected = month.month === selected;
        return (
          <Link
            key={month.month}
            href={`?window=${month.month}`}
            scroll={false}
            className="flex flex-1 flex-col items-center gap-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-sky"
            title={
              month.invoices === 0
                ? `${month.month} — no invoices`
                : `${month.month} — ${month.invoices} invoice${month.invoices === 1 ? "" : "s"}. Click for the breakdown.`
            }
          >
            <span className="text-[10px] tabular-nums text-ink-muted">
              {formatINR(month.paise)}
            </span>
            <div
              className={`w-full rounded-t transition-opacity hover:opacity-80 ${
                partial ? "bg-brand-sky/50" : "bg-brand-navy"
              } ${isSelected ? "ring-2 ring-brand-sky ring-offset-1" : ""}`}
              style={{ height: `${Math.max((month.paise / max) * 80, 2)}px` }}
            />
            <span
              className={`text-[10px] ${isSelected ? "font-semibold text-ink" : "text-ink-muted"}`}
            >
              {month.month.slice(2)}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/** "not applicable" reads differently from "—", and the difference matters. */
function NotMetered({ applicable }: { applicable: boolean }) {
  return applicable ? (
    <span className="text-ink-muted">—</span>
  ) : (
    <span
      className="text-ink-muted/70"
      title="Metering is not a concept for this vendor — a VPS, a SaaS seat or a subscription. The invoice is real; there is nothing to meter it against."
    >
      n/a
    </span>
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
          <NotMetered applicable={!vendor.metering_not_applicable} />
        )}
      </td>
      <td className="py-2.5 pr-3 text-right tabular-nums text-ink-muted">
        {vendor.metered_calls == null ? (
          <NotMetered applicable={!vendor.metering_not_applicable} />
        ) : (
          <>
            {formatCount(vendor.metered_calls)}
            {/* The unit, always. This column holds AI calls for one row and
                WhatsApp messages for the next; an unlabelled integer invited
                reading one as the other. */}
            {vendor.metered_unit && (
              <span className="ml-1 text-[10px] text-ink-muted/80">
                {vendor.metered_unit}
              </span>
            )}
          </>
        )}
      </td>
      <td className="py-2.5 pr-3 text-right tabular-nums text-ink">
        {vendor.billed_paise > 0 ? formatINR(vendor.billed_paise) : "—"}
      </td>
      <td className="py-2.5 pr-3 text-right">{delta(gap)}</td>
      <td className="py-2.5 text-[11px] text-ink-muted">
        {vendor.metered_from ??
          (vendor.metering_not_applicable
            ? "metering not applicable"
            : "not metered")}
      </td>
    </tr>
  );
}

export default async function OperationsSpendPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const windowKey = parseSpendWindow(params);

  // The breakdown only exists for a calendar month — "the invoices behind the
  // last 30 days" is not a thing anyone asked to see, and it would not tie back
  // to a bar on the chart.
  let breakdown: BreakdownRow[] | null = null;

  let view: Awaited<ReturnType<typeof getSpendView>>;
  try {
    view = await getSpendView(windowKey);
    if (windowKey !== TRAILING_30) {
      breakdown = await getSpendBreakdown(windowKey);
    }
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-xs text-ink-muted">
          Metered and billed are independent reads over{" "}
          <strong className="text-ink">the same window</strong> —{" "}
          <span className="text-ink">{view.window.label}</span>. They are meant
          to agree; the gap is the signal. Change the window below or click a
          bar on the burn chart.
        </p>
        <div className="flex items-center gap-3">
          <SpendWindowSelector selected={view.window.key} />
          <AutoRefresh intervalMs={60_000} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Monthly tech burn</CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Approved invoices in the tech bucket, by invoice date (falling
              back to the approval date). Six calendar months — a month with no
              invoices is drawn as a real zero rather than dropped, so the axis
              never closes a gap. The lighter bar is the month in progress.{" "}
              <strong className="text-ink">Click a bar</strong> for the invoices
              behind it.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <BurnChart
              burn={view.burn}
              currentMonth={view.current_month}
              selected={view.window.key}
            />
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <span className="text-ink-muted">
                MTD{" "}
                <span className="font-semibold text-ink">
                  {formatINR(view.billed_tech_mtd_paise)}
                </span>
              </span>
              <span className="text-ink-muted">
                {view.window.label}{" "}
                <span className="font-semibold text-ink">
                  {formatINR(view.billed_window_paise)}
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

            {/* The reconciliation. Every figure above is a SUBSET of the raw
                `bucket = 'tech'` total, so stating both halves and their sum is
                what makes the subsetting auditable rather than mysterious. */}
            {view.excluded_window_paise > 0 && (
              <p className="text-[11px] text-ink-muted">
                {view.window.label}:{" "}
                <span className="font-semibold text-ink">
                  {formatINR(view.billed_window_paise)}
                </span>{" "}
                tech +{" "}
                <span className="font-semibold text-ink">
                  {formatINR(view.excluded_window_paise)}
                </span>{" "}
                excluded ={" "}
                <span className="font-semibold text-ink">
                  {formatINR(
                    view.billed_window_paise + view.excluded_window_paise,
                  )}
                </span>{" "}
                in the raw <code>{view.tech_filter_column}</code> ={" "}
                &lsquo;tech&rsquo; bucket. The exclusions are itemised below.
              </p>
            )}

            {view.no_vendor_invoices > 0 && (
              <p className="text-[11px] text-ink-muted">
                Includes {view.no_vendor_invoices} invoice
                {view.no_vendor_invoices === 1 ? "" : "s"} worth{" "}
                {formatINR(view.no_vendor_paise)} with no vendor recorded — real
                money with no row to sit on in the vendor table below.
              </p>
            )}

            {view.undated_invoices > 0 && (
              <p className="text-[11px] text-warning">
                {view.undated_invoices} approved tech invoice
                {view.undated_invoices === 1 ? "" : "s"} worth{" "}
                {formatINR(view.undated_paise)} have neither an invoice date nor
                an approval date, so they appear in <em>no</em> figure on this
                page — not the bars, not MTD, not the window total. Fix the date
                at source to bring them in.
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
            <CardTitle className="text-base">
              Metered vs billed · {view.window.label}
            </CardTitle>
            <p className="mt-1 text-xs text-ink-muted">
              Both columns cover{" "}
              <span className="text-ink">
                {view.window.from} to {view.window.to}
              </span>{" "}
              (IST, inclusive) — the same span, which is what makes the gap
              mean anything. AI call cost is metered in INR paise and directly
              comparable. Everything else is a volume count in its own unit; we
              hold no rate card for those vendors, so a cost there would be
              invented.
            </p>
          </div>
          <Badge variant="muted">
            AI {formatINR(view.ai_cost_window_paise)} ·{" "}
            {formatCount(view.ai_calls_window)} calls
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

      {view.excluded.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">
                Excluded from Tech Spend · {view.window.label}
              </CardTitle>
              <p className="mt-1 max-w-3xl text-xs text-ink-muted">
                Invoices the database filed under{" "}
                <code>{view.tech_filter_column} = &lsquo;tech&rsquo;</code> that
                are not technology spend. That column is written by a process
                outside this codebase and keys largely on the vendor&apos;s legal
                name, which is how our own{" "}
                <strong className="text-ink">
                  &ldquo;ITARANG TECHNOLOGIES LLP&rdquo; GST payments
                </strong>{" "}
                ended up in the technology run-rate. The rules that remove them
                live in <code>src/lib/operations/techSpendRules.ts</code> and key
                on vendor and description only — never on an invoice id — so they
                apply to invoices that do not exist yet. Nothing is hidden: every
                row is listed with its reason, and the totals above reconcile.
              </p>
            </div>
            <Badge variant="muted">
              {formatINR(view.excluded_window_paise)} ·{" "}
              {formatCount(view.excluded.length)}{" "}
              {view.excluded.length === 1 ? "invoice" : "invoices"}
            </Badge>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3">Vendor</th>
                    <th className="py-2 pr-3">Description</th>
                    <th className="py-2 pr-3">Reason</th>
                    <th className="py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {view.excluded.map((row, i) => (
                    <tr
                      key={`${row.effective_date}|${row.vendor}|${row.paise}|${i}`}
                      className="border-b border-border/60 last:border-0"
                    >
                      <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-ink-muted">
                        {row.effective_date ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-ink">
                        {row.vendor_label ?? "— no vendor —"}
                      </td>
                      <td className="max-w-[20rem] truncate py-2 pr-3 text-[12px] text-ink-muted">
                        {row.description ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-[12px]">
                        <span
                          className={
                            row.reason === "unclassified"
                              ? "text-warning"
                              : "text-ink-muted"
                          }
                          title={row.explanation}
                        >
                          {row.reason_label}
                        </span>
                      </td>
                      <td className="py-2 text-right tabular-nums text-ink-muted">
                        {formatINR(row.paise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11px] text-ink-muted">
              A row marked <span className="text-warning">Unclassified</span> was
              not recognisable either way and is excluded pending review — add
              the vendor to <code>VENDORS</code> in{" "}
              <code>src/lib/operations/vendors.ts</code> if it belongs in Tech
              Spend, or have it re-bucketed at source if it does not.
            </p>
          </CardContent>
        </Card>
      )}

      {breakdown && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">
                Invoices behind {view.window.label}
              </CardTitle>
              <p className="mt-1 text-xs text-ink-muted">
                Every approved tech-bucket invoice with an effective date in{" "}
                {view.window.key}. Rows struck through were excluded by the Tech
                Spend rules and do NOT count toward the bar — they are listed
                because explaining the bar means accounting for the invoices that
                are not in it. The rest sum to the bar exactly.
              </p>
            </div>
            <Badge variant="muted">
              {formatINR(
                breakdown
                  .filter((row) => row.included)
                  .reduce((sum, row) => sum + row.paise, 0),
              )}{" "}
              · {formatCount(breakdown.filter((row) => row.included).length)}{" "}
              {breakdown.filter((row) => row.included).length === 1
                ? "invoice"
                : "invoices"}
            </Badge>
          </CardHeader>
          <CardContent>
            {breakdown.length === 0 ? (
              <p className="text-sm text-ink-muted">
                No approved tech invoices with an effective date in{" "}
                {view.window.key}.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      <th className="py-2 pr-3">Date</th>
                      <th className="py-2 pr-3">Vendor</th>
                      <th className="py-2 pr-3">Invoice</th>
                      <th className="py-2 pr-3">Description</th>
                      <th className="py-2 pr-3">In Tech Spend</th>
                      <th className="py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.map((row) => (
                      <tr
                        key={row.id}
                        className={`border-b border-border/60 last:border-0 ${
                          row.included ? "" : "opacity-60"
                        }`}
                      >
                        <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-ink-muted">
                          {row.effective_date ?? "—"}
                        </td>
                        <td className="py-2 pr-3 text-ink">
                          {row.vendor_label ?? "—"}
                          {row.vendor &&
                            row.vendor_label &&
                            row.vendor !== row.vendor_label && (
                              <span
                                className="ml-1 text-[11px] text-ink-muted"
                                title={row.vendor}
                              >
                                ({row.vendor})
                              </span>
                            )}
                        </td>
                        <td className="py-2 pr-3 font-mono text-[11px] text-ink-muted">
                          {row.invoice_number ?? "—"}
                        </td>
                        <td className="max-w-[22rem] truncate py-2 pr-3 text-[12px] text-ink-muted">
                          {row.description ?? "—"}
                        </td>
                        <td
                          className="py-2 pr-3 text-[12px] text-ink-muted"
                          title={row.explanation}
                        >
                          {row.included ? "yes" : `no — ${row.reason_label}`}
                        </td>
                        <td
                          className={`py-2 text-right tabular-nums ${
                            row.included
                              ? "text-ink"
                              : "text-ink-muted line-through"
                          }`}
                        >
                          {formatINR(row.paise)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
