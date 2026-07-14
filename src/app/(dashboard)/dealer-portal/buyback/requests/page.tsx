"use client";

/**
 * "My Requests" — the dealer's full request list (design handoff
 * iTarang Portal.dc.html scrMyRequests, lines 601-610). Same columns as the
 * dashboard's "Recent requests" card (DealerRequestsTable), just every row
 * instead of the 5 most recent, and no client-side filtering — the API
 * (GET /api/buyback/requests) is unpaginated, so neither is this page.
 *
 * Route precedence note: this is a static `requests` segment as a sibling of
 * `[id]`. Next.js resolves the static segment first, so
 * /dealer-portal/buyback/requests never gets swallowed by the `[id]` dynamic
 * route.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import DealerRequestsTable, {
  type DealerRequestRow,
} from "@/components/buyback/DealerRequestsTable";
import { Card, PageHeader } from "@/components/buyback/ui";

export default function DealerMyRequestsPage() {
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

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader
          title="My Requests"
          sub="All your buyback requests"
          right={
            <Link
              href="/dealer-portal/buyback/new"
              className="rounded-lg bg-emerald-600 px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-emerald-700"
            >
              + New Buyback Request
            </Link>
          }
        />

        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : (
          <Card>
            <DealerRequestsTable
              requests={requests}
              loading={loading}
              emptyMessage="No buyback requests yet."
            />
          </Card>
        )}
      </div>
    </div>
  );
}
