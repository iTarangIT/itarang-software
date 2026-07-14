"use client";

/**
 * M01 — the dealer's buyback dashboard, rebuilt to the prototype
 * (iTarang Portal.dc.html scrDealerDash, lines 439-464): a KPI row plus a
 * "Recent requests" card, on the shared buyback UI kit
 * (src/components/buyback/ui) rather than the page's own ad hoc table.
 *
 * Entity-scoped by the API: /api/buyback/requests only ever returns rows whose
 * dealer_entity_id matches the caller's. Another dealer's request is not just
 * hidden here — it 404s at the API too.
 *
 * Drafts: the prototype's four KPI buckets deliberately exclude DRAFT (see
 * handoff:446-449 — "Submitted" is `status !== DRAFT`, and none of the other
 * three buckets include it either), so there is no dedicated "Drafts" tile
 * here, unlike the page this replaces. The affordance is not gone though: a
 * draft still shows up as its own row (with a "Draft" status chip) in Recent
 * requests and on My Requests, so it stays findable — just folded into the
 * shared table instead of a standalone count.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import { useAuth } from "@/components/auth/AuthProvider";
import DealerBuybackSearch from "@/components/buyback/DealerBuybackSearch";
import DealerRequestsTable, {
  type DealerRequestRow,
} from "@/components/buyback/DealerRequestsTable";
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

export default function DealerBuybackPage() {
  const { user } = useAuth();
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

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader
          title="Dashboard"
          sub={
            user?.name
              ? `Welcome back, ${user.name} — your battery buyback overview`
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

        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : !loading && requests.length === 0 ? (
          <EmptyState
            icon="🔋"
            title="No requests yet"
            body="Create your first buyback request to get started."
          />
        ) : (
          <>
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
      </div>
    </div>
  );
}
