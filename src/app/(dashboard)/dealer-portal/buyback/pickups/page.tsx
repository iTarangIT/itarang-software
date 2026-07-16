"use client";

/**
 * Dealer Pickups — the collection schedule for their accepted deals (design
 * handoff iTarang Portal.dc.html scrDealerPickups, lines 753-766, incl.
 * pickupRow 762-766).
 *
 * Data: the dealer list endpoint's Ext-8 `pickup` field (latest pickup per
 * request, dealer-safe fields only — the API serializes it through
 * toDealerPickup, so the BWM S3 keys and internal ids are structurally
 * absent). Requests without a pickup simply don't appear here.
 *
 * Counts: `{actual}/{submitted} units` renders only once a completion has
 * recorded them (both null on a merely scheduled pickup) — with "✓ matched"
 * or "⚠ variance" per the prototype. The variance ACK flow itself lives on
 * the request detail's overview tab (VarianceBanner); this list just flags it.
 *
 * Route precedence: a static `pickups` segment as a sibling of `[id]` — Next
 * resolves the static segment first (same note as requests/page.tsx).
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import type { DealerRequestRow } from "@/components/buyback/DealerRequestsTable";
import StatusChip from "@/components/buyback/StatusChip";
import { Card, EmptyState, PageHeader } from "@/components/buyback/ui";

/** Ext-8 — the dealer-safe pickup summary on GET /api/buyback/requests. */
interface PickupSummary {
  scheduled_at: string | null;
  completed_at: string | null;
  address: string | null;
  contact: string | null;
  submitted_units: number | null;
  actual_units: number | null;
}

interface RowWithPickup extends DealerRequestRow {
  pickup: PickupSummary | null;
}

export default function DealerPickupsPage() {
  const [requests, setRequests] = useState<RowWithPickup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/buyback/requests")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) {
          setError(j?.error?.message ?? "Could not load your pickups.");
          return;
        }
        setRequests(j?.data?.requests ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load your pickups.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const withPickup = requests.filter((r) => r.pickup != null);

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader title="Pickups" sub="Scheduled and completed collections" />

        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : withPickup.length === 0 ? (
          <EmptyState
            icon="🚚"
            title="No pickups yet"
            body="Pickups appear here once a deal is accepted and scheduled."
          />
        ) : (
          withPickup.map((r) => (
            <div key={r.request_id} className="mb-4">
              <Card>
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                  <Link
                    href={`/dealer-portal/buyback/${r.request_id}`}
                    className="text-[13.5px] font-bold text-slate-900 hover:underline"
                  >
                    {r.request_no}
                  </Link>
                  <StatusChip status={r.status} />
                </div>
                <PickupRow pickup={r.pickup!} />
              </Card>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** One pickup row — proto pickupRow (753-766): address left, counts + chip right. */
function PickupRow({ pickup }: { pickup: PickupSummary }) {
  const collected = pickup.completed_at != null;
  const when = pickup.completed_at ?? pickup.scheduled_at;
  const dateLabel = when
    ? new Date(when).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : "To be scheduled";

  // Bold the address's first segment ("Shakti Battery House"), then the full
  // address below it — the proto's split(',') treatment, minus its |[1]| bug.
  const firstSegment = pickup.address?.split(",")[0]?.trim() || "Pickup";

  const hasCounts = pickup.submitted_units != null && pickup.actual_units != null;
  const matched = hasCounts && pickup.actual_units === pickup.submitted_units;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div>
        <div className="text-[13px] font-bold text-slate-900">{firstSegment}</div>
        {pickup.address && (
          <div className="mt-0.5 text-[12px] text-slate-500">{pickup.address}</div>
        )}
        <div className="text-[12px] text-slate-500">
          📅 {dateLabel}
          {pickup.contact ? ` · ${pickup.contact}` : ""}
        </div>
      </div>

      <div className="flex items-center gap-3">
        {hasCounts && (
          <div className="text-right text-[12px]">
            <div className="font-bold text-slate-900">
              {pickup.actual_units}/{pickup.submitted_units} units
            </div>
            {matched ? (
              <span className="text-[11px] text-green-600">✓ matched</span>
            ) : (
              <span className="text-[11px] text-red-600">⚠ variance</span>
            )}
          </div>
        )}
        <span
          className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-[3px] text-[11px] font-bold tracking-wide ${
            collected ? "bg-emerald-100 text-emerald-700" : "bg-teal-100 text-teal-700"
          }`}
        >
          {collected ? "Collected" : "Scheduled"}
        </span>
      </div>
    </div>
  );
}
