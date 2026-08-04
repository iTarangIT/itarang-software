"use client";

/**
 * M01 — the dealer's buyback dashboard body: a KPI row plus a "Recent requests"
 * card, on the shared buyback UI kit (src/components/buyback/ui) rather than an
 * ad hoc table.
 *
 * Extracted from the /dealer-portal/buyback page when E-202 gave scrap dealers
 * a buyback-only portal: for them /dealer-portal IS this dashboard, so it has
 * two mount points and cannot stay inside a route file. The page is now a thin
 * wrapper around this component.
 *
 * Entity-scoped by the API: /api/buyback/requests only ever returns rows whose
 * dealer_entity_id matches the caller's. Another dealer's request is not just
 * hidden here — it 404s at the API too.
 *
 * Drafts: the prototype's four KPI buckets deliberately exclude DRAFT (handoff
 * 446-449 — "Submitted" is `status !== DRAFT`, and none of the other three
 * buckets include it either), so there is still no "Drafts" KPI tile.
 *
 * A status chip in the table turned out not to be enough (E-194). Of the first
 * 32 requests on db-1, 24 died in DRAFT and three of the four dealers never
 * landed one in the review queue — a "Draft" chip reads as a stage in the
 * process, not as "this is still sitting with you and iTarang cannot see it".
 * Hence DraftBanner above the KPI row: it names each draft and what the submit
 * gate is waiting for. Not a fifth KPI, because a count wouldn't have told
 * anyone the answer was "add photos".
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import DealerBuybackSearch from "@/components/buyback/DealerBuybackSearch";
import DealerRequestsTable, {
  type DealerRequestRow,
} from "@/components/buyback/DealerRequestsTable";
import DraftBanner from "@/components/buyback/DraftBanner";
import BuybackActionCenter from "@/components/buyback/notifications/BuybackActionCenter";
import { Card, EmptyState, KpiCard, PageHeader } from "@/components/buyback/ui";

const PENDING_STATES = new Set([
  "SUBMITTED",
  "UNDER_REVIEW",
  "INFO_REQUESTED",
  "NEGOTIATING",
  "FINAL_OFFER_SENT",
]);

const IN_PROGRESS_STATES = new Set([
  "DEALER_ACCEPTED",
  "MARGIN_SET",
  "VENDOR_ROUTED",
  "VENDOR_NEGOTIATING",
  "VENDOR_AGREED",
  "PO_EXCHANGED",
  "PICKUP_SCHEDULED",
  "PICKED_UP",
  "INVOICE_RAISED",
  "INVOICE_APPROVED",
  "SETTLED",
  "CLOSED",
]);

const NEW_REQUEST_BUTTON =
  "rounded-lg bg-green-600 px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-green-700";

// U5 — same skeleton approach as the admin dashboard
// (admin/buyback/dashboard/page.tsx DashboardSkeleton): while `loading`, the
// KPI row rendered computed-zero KpiCards (Submitted/Pending/etc. all start
// at 0 before `requests` has loaded), which reads as "everything is zero"
// for a beat rather than "loading". Skeleton tiles instead.
function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-slate-200/70 ${className}`} />;
}

export default function BuybackDashboardPanel({
  dealerName,
  title = "Dashboard",
}: {
  /** Used in the greeting; the caller already knows who the dealer is. */
  dealerName?: string | null;
  /**
   * "Dashboard" on /dealer-portal/buyback. A scrap dealer's /dealer-portal
   * mounts this as their whole dashboard and passes a title that says so,
   * rather than two pages both headed "Dashboard".
   */
  title?: string;
}) {
  const [requests, setRequests] = useState<DealerRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/buyback/requests")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) {
          setError(j?.error?.message ?? "Could not load your buyback requests.");
          return;
        }
        setRequests(j?.data?.requests ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load your buyback requests.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const submitted = requests.filter((r) => r.status !== "DRAFT").length;
  const pending = requests.filter((r) => PENDING_STATES.has(r.status)).length;
  const inProgress = requests.filter((r) => IN_PROGRESS_STATES.has(r.status)).length;
  const rejected = requests.filter((r) => r.status === "REJECTED").length;

  const recent = requests.slice(0, 5);

  // A draft is saved but was never sent to iTarang, and nothing on this page
  // used to say so — the "Draft" chip in the table below is easy to read as a
  // status rather than as "still sitting with you". On db-1 this stranded 24 of
  // the first 32 requests: three of four dealers had never landed one in the
  // review queue and had no way to know why.
  const drafts = requests.filter((r) => r.status === "DRAFT");

  return (
    <>
      <PageHeader
        title={title}
        sub={
          dealerName
            ? `Welcome back, ${dealerName} — your battery buyback overview`
            : "Welcome back — your battery buyback overview"
        }
        right={
          <div className="flex flex-wrap items-center gap-2.5">
            <DealerBuybackSearch />
            <Link href="/dealer-portal/buyback/new" className={NEW_REQUEST_BUTTON}>
              + New Buyback Request
            </Link>
          </div>
        }
      />

      <BuybackActionCenter className="mb-5" />

      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : loading ? (
        <>
          <div className="mb-[22px] grid grid-cols-4 gap-3.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonBlock key={i} className="h-[84px]" />
            ))}
          </div>
          <Card title="Recent requests">
            <DealerRequestsTable requests={[]} loading emptyMessage="No requests yet." />
          </Card>
        </>
      ) : requests.length === 0 ? (
        <EmptyState
          icon="🔋"
          title="No requests yet"
          body="Create your first buyback request to get started."
        />
      ) : (
        <>
          {drafts.length > 0 && <DraftBanner drafts={drafts} />}

          <div className="mb-[22px] grid grid-cols-4 gap-3.5">
            <KpiCard label="Submitted" value={submitted} accent="text-blue-600" />
            <KpiCard label="Pending" value={pending} accent="text-amber-500" />
            <KpiCard
              label="Accepted / In Progress"
              value={inProgress}
              accent="text-green-600"
            />
            <KpiCard label="Rejected" value={rejected} accent="text-red-600" />
          </div>

          <Card
            title="Recent requests"
            action={
              <Link
                href="/dealer-portal/buyback/requests"
                className="text-[12.5px] font-semibold text-blue-600 hover:underline"
              >
                View all →
              </Link>
            }
          >
            <DealerRequestsTable
              requests={recent}
              loading={loading}
              emptyMessage="No requests yet."
            />
          </Card>
        </>
      )}
    </>
  );
}
