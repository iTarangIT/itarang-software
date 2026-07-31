"use client";

/**
 * Scrap vendors (M09 / M18-lite → E-222), on the shared buyback UI kit
 * (design handoff, iTarang Portal.dc.html `scrVendors`, lines 958-966).
 *
 * "+ Add vendor" used to open an inline seven-field modal. E-222 replaced it
 * with a real onboarding page (/admin/buyback/vendors/new) that also captures
 * an address, the three statutory documents, and — the reason the modal had to
 * go — a portal login whose password iTarang generates and emails.
 *
 * TWO LISTS, AND WHY THE SECOND ONE MATTERS. The main grid is
 * `listRoutableVendors` — an ACTIVE SCRAP_VENDOR role, which is M18's AC
 * ("unonboarded vendor unselectable for routing") expressed as a join. Above it
 * sits the PENDING list, which before E-222 was unreachable from any screen.
 * It has to be reachable now: onboarding flips a vendor ACTIVE only when their
 * credentials email actually leaves, so a bounced email leaves a real vendor,
 * with real documents, who cannot be routed and whom nobody can see. That is a
 * trapdoor unless this page offers the retry.
 *
 * DATA-BINDING NOTE — the "Active" pill on the main grid is rendered
 * unconditionally rather than read off a field: every row that query CAN return
 * is active by construction (its own WHERE clause). GSTIN and a thread count
 * are omitted because neither is in this endpoint's payload.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { Card, EmptyState, PageHeader } from "@/components/buyback/ui";

interface Vendor {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  categories: unknown;
  regions: string[];
  payment_terms: string | null;
}

interface PendingVendor {
  id: string;
  entity_id: string;
  name: string;
  email: string | null;
  gstin: string | null;
  onboarding_status: string | null;
  has_login: boolean;
  /** null when no credentials were ever attempted — i.e. an unvetted self-registrant. */
  credential_status: string | null;
  credential_error: string | null;
}

/** ["Li-ion", "Lead-acid"] → "Li-ion, Lead-acid"; empty/missing → "—". */
function listOrDash(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? value.join(", ") : "—";
}

export default function BuybackVendorsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [pending, setPending] = useState<PendingVendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [active, waiting] = await Promise.all([
        fetch("/api/admin/buyback/vendors").then((r) => r.json()).catch(() => null),
        fetch("/api/admin/buyback/vendors?status=pending")
          .then((r) => r.json())
          .catch(() => null),
      ]);
      if (cancelled) return;
      setVendors(active?.data?.vendors ?? []);
      setPending(waiting?.data?.vendors ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const retryCredentials = useCallback(async (entityId: string) => {
    setRetryingId(entityId);
    setError(null);

    const res = await fetch(
      `/api/admin/buyback/vendors/${encodeURIComponent(entityId)}/credentials`,
      { method: "POST" },
    ).catch(() => null);

    const json = await res?.json().catch(() => null);
    setRetryingId(null);

    if (!json?.success) {
      setError(json?.error?.message ?? "The credentials could not be sent.");
      return;
    }
    // Not dispatched is not an error the page owns — the refreshed row carries
    // the mail server's own reason, which is more useful than a banner.
    if (!json.data?.credential?.dispatched) {
      setError(json.data?.credential?.error ?? "The credentials email did not go out.");
    }
    setReloadKey((k) => k + 1);
  }, []);

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader
          title="Vendors"
          sub="Scrap vendors who buy end-of-life battery lots. Onboarding creates their portal login."
          right={
            <Link
              href="/admin/buyback/vendors/new"
              className="rounded-lg bg-green-600 px-3.5 py-2 text-[12.5px] font-semibold text-white hover:bg-green-700"
            >
              + Add vendor
            </Link>
          }
        />

        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          <>
            {pending.length > 0 && (
              <section className="mb-6">
                <h2 className="mb-2.5 text-[12.5px] font-bold text-slate-700">
                  Waiting ({pending.length})
                </h2>
                <p className="mb-3 text-[12px] text-slate-500">
                  These vendors exist but cannot be routed a deal. A vendor is activated when
                  their login email is delivered.
                </p>

                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                  {pending.map((v) => (
                    <Card key={v.entity_id}>
                      <div className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-[14.5px] font-bold text-slate-900">{v.name}</div>
                            <div className="mt-[2px] text-[12px] text-slate-500">
                              {v.email ?? "no contact email"}
                            </div>
                          </div>
                          <span className="inline-flex shrink-0 rounded-full bg-amber-100 px-2.5 py-[3px] text-[11px] font-bold text-amber-700">
                            Pending
                          </span>
                        </div>

                        <p className="mt-3 text-[12px] text-slate-600">
                          {v.credential_status === "credential_dispatch_failed"
                            ? "Their login email did not go out."
                            : v.credential_status === null
                              ? // No dispatch was ever attempted: a self-registered
                                // vendor nobody has vetted, not a delivery failure.
                                "Registered themselves — nobody has vetted this firm yet."
                              : "Their login is being sent."}
                        </p>

                        {v.credential_error && (
                          <p className="mt-1.5 break-words font-mono text-[11px] text-red-600">
                            {v.credential_error}
                          </p>
                        )}

                        <div className="mt-3.5 flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => void retryCredentials(v.entity_id)}
                            disabled={retryingId === v.entity_id || !v.email}
                            className="rounded-lg bg-bb-navy px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                          >
                            {retryingId === v.entity_id
                              ? "Sending…"
                              : v.credential_status
                                ? "↻ Retry credentials"
                                : "Send login & activate"}
                          </button>
                          <span className="font-mono text-[11px] text-slate-400">
                            {v.gstin ?? "—"}
                          </span>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              </section>
            )}

            {vendors.length === 0 ? (
              <EmptyState
                icon="🏭"
                title="No vendors yet"
                body="A deal cannot be quoted out until there is at least one."
              />
            ) : (
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                {vendors.map((v) => (
                  <Card key={v.id}>
                    <div className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-[14.5px] font-bold text-slate-900">{v.name}</div>
                        <span className="inline-flex shrink-0 rounded-full bg-green-100 px-2.5 py-[3px] text-[11px] font-bold text-green-700">
                          Active
                        </span>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-2.5 text-[12.5px]">
                        <div>
                          <div className="text-[11px] font-semibold text-slate-400">Categories</div>
                          <div className="mt-[1px] font-semibold text-slate-700">
                            {listOrDash(v.categories)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] font-semibold text-slate-400">Regions</div>
                          <div className="mt-[1px] font-semibold text-slate-700">
                            {listOrDash(v.regions)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] font-semibold text-slate-400">
                            Payment terms
                          </div>
                          <div className="mt-[1px] font-semibold text-slate-700">
                            {v.payment_terms ?? "—"}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] font-semibold text-slate-400">Contact</div>
                          <div className="mt-[1px] font-semibold text-slate-700">
                            {v.email ?? "—"}
                          </div>
                        </div>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
