import Link from "next/link";
import { db } from "@/lib/db";
import { and, desc, eq } from "drizzle-orm";
import { AlertTriangle } from "lucide-react";
import {
  dealers,
  leads,
  nbfcLeadAssignments,
  productSelections,
} from "@/lib/db/schema";
import { getCurrentTenant } from "@/lib/nbfc/tenant";
import AcquireCsvButton, {
  type AcquireRow,
} from "./_components/AcquireCsvButton";

// Acquire pipeline — Addendum V0.2 §6. Lists nbfc_lead_assignments rows for the
// current tenant with URL-driven filters, KPI summary cards, search, sort,
// pagination and CSV export — mirrors the Lead Intelligence (/nbfc/leads)
// pattern. Per-lead action surfaces live on the [leadId] detail page.

export const dynamic = "force-dynamic";

interface SearchParams {
  status?: string;
  q?: string;
  dealer?: string;
  residence?: string;
  amount_min?: string;
  amount_max?: string;
  from?: string;
  to?: string;
  sort?: string;
  page?: string;
  page_size?: string;
}

const STATUSES = [
  { id: "pending", label: "Pending" },
  { id: "in_progress", label: "In progress" },
  { id: "offer_submitted", label: "Offer submitted" },
  { id: "selected", label: "Selected" },
  { id: "not_selected", label: "Not selected" },
  { id: "declined", label: "Declined" },
] as const;

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  offer_submitted: "Offer submitted",
  selected: "Selected",
  not_selected: "Not selected",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  in_progress: "bg-sky-50 text-sky-700 border-sky-200",
  offer_submitted: "bg-indigo-50 text-indigo-700 border-indigo-200",
  selected: "bg-emerald-50 text-emerald-700 border-emerald-200",
  not_selected: "bg-slate-50 text-slate-600 border-slate-200",
  declined: "bg-rose-50 text-rose-700 border-rose-200",
  withdrawn: "bg-slate-50 text-slate-500 border-slate-200",
};

const SORT_OPTIONS = [
  { id: "assigned_desc", label: "Newest first" },
  { id: "assigned_asc", label: "Oldest first" },
  { id: "price_desc", label: "Asset price: high → low" },
  { id: "price_asc", label: "Asset price: low → high" },
  { id: "name_asc", label: "Customer name: A → Z" },
];

const PAGE_SIZE_OPTIONS = [20, 50, 100];

const FIELD_LABEL =
  "block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1";
const FIELD_INPUT =
  "border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm bg-white";

function resolveSortKey(raw: string | undefined): string {
  if (raw && SORT_OPTIONS.some((o) => o.id === raw)) return raw;
  return "assigned_desc";
}

function sortRows(rows: AcquireRow[], key: string): AcquireRow[] {
  const out = [...rows];
  const ts = (r: AcquireRow) =>
    r.assigned_at ? new Date(r.assigned_at).getTime() : 0;
  switch (key) {
    case "assigned_asc":
      return out.sort((a, b) => ts(a) - ts(b));
    case "price_desc":
      return out.sort((a, b) => (b.final_price ?? -1) - (a.final_price ?? -1));
    case "price_asc":
      return out.sort(
        (a, b) => (a.final_price ?? Infinity) - (b.final_price ?? Infinity),
      );
    case "name_asc":
      return out.sort((a, b) =>
        (a.customer_name ?? "").localeCompare(b.customer_name ?? ""),
      );
    case "assigned_desc":
    default:
      return out.sort((a, b) => ts(b) - ts(a));
  }
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function fmtInr(v: number | null): string {
  if (v == null) return "—";
  return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export default async function AcquireQueuePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const tenant = await getCurrentTenant();
  const params = (await searchParams) ?? {};

  const page = Math.max(1, Number(params.page ?? 1));
  const pageSize = Math.min(100, Math.max(20, Number(params.page_size ?? 20)));

  const raw = await db
    .select({
      assignment_id: nbfcLeadAssignments.id,
      assignment_status: nbfcLeadAssignments.status,
      assigned_at: nbfcLeadAssignments.assigned_at,
      lead_id: leads.id,
      customer_name: leads.full_name,
      customer_phone: leads.phone,
      state: leads.state,
      city: leads.city,
      resident_status: leads.resident_status,
      final_price: productSelections.final_price,
      dealer_code: leads.dealer_id,
      dealer_name: dealers.company_name,
    })
    .from(nbfcLeadAssignments)
    .innerJoin(leads, eq(leads.id, nbfcLeadAssignments.lead_id))
    .leftJoin(
      productSelections,
      and(
        eq(productSelections.lead_id, nbfcLeadAssignments.lead_id),
        eq(productSelections.payment_mode, "finance"),
      ),
    )
    .leftJoin(dealers, eq(dealers.dealer_id, leads.dealer_id))
    .where(eq(nbfcLeadAssignments.tenant_id, tenant.id))
    .orderBy(desc(nbfcLeadAssignments.assigned_at))
    .limit(1000);

  const enriched: AcquireRow[] = raw.map((r) => ({
    assignment_id: r.assignment_id,
    assignment_status: r.assignment_status,
    assigned_at: r.assigned_at ? new Date(r.assigned_at).toISOString() : null,
    lead_id: r.lead_id,
    customer_name: r.customer_name,
    customer_phone: r.customer_phone,
    state: r.state,
    city: r.city,
    resident_status: r.resident_status,
    final_price: r.final_price != null ? Number(r.final_price) : null,
    dealer_code: r.dealer_code,
    dealer_name: r.dealer_name,
  }));

  // Distinct values for the filter dropdowns.
  const dealerOptions = Array.from(
    new Set(enriched.map((r) => r.dealer_name).filter((v): v is string => !!v)),
  ).sort();
  const residenceOptions = Array.from(
    new Set(
      enriched.map((r) => r.resident_status).filter((v): v is string => !!v),
    ),
  ).sort();

  const statusFilter = params.status?.trim() ?? "";
  const dealerFilter = params.dealer?.trim() ?? "";
  const residenceFilter = params.residence?.trim() ?? "";
  const q = params.q?.toLowerCase().trim() ?? "";
  const amountMinRaw = Number(params.amount_min);
  const amountMaxRaw = Number(params.amount_max);
  const amountMin =
    params.amount_min && !Number.isNaN(amountMinRaw) ? amountMinRaw : null;
  const amountMax =
    params.amount_max && !Number.isNaN(amountMaxRaw) ? amountMaxRaw : null;
  const from = params.from ? new Date(params.from).getTime() : null;
  const to = params.to
    ? new Date(params.to).getTime() + 24 * 3600 * 1000 - 1
    : null;

  let filtered = enriched.filter((r) => {
    if (statusFilter && r.assignment_status !== statusFilter) return false;
    if (dealerFilter && r.dealer_name !== dealerFilter) return false;
    if (residenceFilter && r.resident_status !== residenceFilter) return false;
    if (amountMin != null && (r.final_price ?? -Infinity) < amountMin)
      return false;
    if (amountMax != null && (r.final_price ?? Infinity) > amountMax)
      return false;
    if (q) {
      const hay =
        `${r.lead_id} ${r.customer_name ?? ""} ${r.customer_phone ?? ""} ${r.dealer_name ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const created = r.assigned_at ? new Date(r.assigned_at).getTime() : 0;
    if (from != null && created < from) return false;
    if (to != null && created > to) return false;
    return true;
  });

  const sortKey = resolveSortKey(params.sort);
  filtered = sortRows(filtered, sortKey);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const slice = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const statusCounts = STATUSES.map((s) => ({
    ...s,
    count: enriched.filter((r) => r.assignment_status === s.id).length,
  }));

  function urlFor(overrides: Partial<SearchParams>): string {
    const next = new URLSearchParams();
    const merged = { ...params, ...overrides };
    for (const [k, v] of Object.entries(merged)) {
      if (v != null && v !== "") next.set(k, String(v));
    }
    return `/nbfc/acquire?${next.toString()}`;
  }

  const hasFilters = Boolean(
    params.status ||
      params.dealer ||
      params.residence ||
      params.amount_min ||
      params.amount_max ||
      params.q ||
      params.from ||
      params.to ||
      params.sort,
  );

  return (
    <div className="px-6 py-8 space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
            Acquire
          </p>
          <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
            Lead Pipeline
          </h1>
          <p className="text-sm text-slate-500 mt-2 max-w-3xl">
            Leads where the customer picked <b>{tenant.display_name}</b> in
            Section G. Each lead may also be in another NBFC&apos;s queue —
            competing offers are decided by the customer.
          </p>
        </div>
        <AcquireCsvButton rows={filtered} />
      </header>

      {/* G-7 disclosure (Addendum §6.2 / §7.4) — flashed on the NBFC page. */}
      <div className="border border-amber-200 bg-amber-50 text-amber-900 rounded-lg px-4 py-3 flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <p className="text-xs leading-relaxed">
          <b>Competitive routing.</b> Field Investigation and Video KYC are run
          at this NBFC&apos;s own cost. If the customer picks another lender,
          this NBFC absorbs that cost — there is no per-service refund.
        </p>
      </div>

      {/* KPI summary cards — counts per status, clickable to filter. */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {statusCounts.map((s) => {
          const active = params.status === s.id;
          return (
            <Link
              key={s.id}
              href={urlFor({ status: active ? "" : s.id, page: "1" })}
              className={`rounded-xl border bg-white p-4 transition ${
                active
                  ? "border-[color:var(--color-brand-navy)] ring-2 ring-[color:var(--color-brand-navy)]"
                  : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                {s.label}
              </p>
              <p className="mt-2 text-2xl font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
                {s.count}
              </p>
            </Link>
          );
        })}
      </section>

      {/* Filter bar — GET form, URL-driven (mirrors /nbfc/leads). */}
      <form className="border border-slate-200 rounded-xl bg-white flex flex-wrap items-end gap-3 p-3">
        <div>
          <label className={FIELD_LABEL}>Dealer</label>
          <select
            name="dealer"
            defaultValue={params.dealer ?? ""}
            className={FIELD_INPUT}
          >
            <option value="">All dealers</option>
            {dealerOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={FIELD_LABEL}>Residence</label>
          <select
            name="residence"
            defaultValue={params.residence ?? ""}
            className={FIELD_INPUT}
          >
            <option value="">All</option>
            {residenceOptions.map((r) => (
              <option key={r} value={r} className="capitalize">
                {r.charAt(0).toUpperCase() + r.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={FIELD_LABEL}>Asset price (₹)</label>
          <div className="flex items-center gap-1">
            <input
              type="number"
              name="amount_min"
              defaultValue={params.amount_min ?? ""}
              placeholder="Min"
              min={0}
              className={`${FIELD_INPUT} w-24`}
            />
            <span className="text-slate-400">–</span>
            <input
              type="number"
              name="amount_max"
              defaultValue={params.amount_max ?? ""}
              placeholder="Max"
              min={0}
              className={`${FIELD_INPUT} w-24`}
            />
          </div>
        </div>
        <div>
          <label className={FIELD_LABEL}>Assigned from</label>
          <input
            type="date"
            name="from"
            defaultValue={params.from ?? ""}
            className={FIELD_INPUT}
          />
        </div>
        <div>
          <label className={FIELD_LABEL}>Assigned to</label>
          <input
            type="date"
            name="to"
            defaultValue={params.to ?? ""}
            className={FIELD_INPUT}
          />
        </div>
        <div>
          <label className={FIELD_LABEL}>Sort by</label>
          <select
            name="sort"
            defaultValue={resolveSortKey(params.sort)}
            className={FIELD_INPUT}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[200px] flex-1">
          <label className={FIELD_LABEL}>Search</label>
          <input
            type="search"
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Lead ID, customer, phone, dealer"
            className={`${FIELD_INPUT} w-full`}
          />
        </div>
        <div>
          <label className={FIELD_LABEL}>Per page</label>
          <select
            name="page_size"
            defaultValue={String(pageSize)}
            className={FIELD_INPUT}
          >
            {PAGE_SIZE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {params.status ? (
          <input type="hidden" name="status" value={params.status} />
        ) : null}
        <button
          type="submit"
          className="rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-1.5 text-sm font-bold text-white"
        >
          Apply
        </button>
        {hasFilters && (
          <Link
            href="/nbfc/acquire"
            className="self-center text-xs text-slate-500 underline"
          >
            Reset
          </Link>
        )}
      </form>

      {slice.length === 0 ? (
        <div className="border border-slate-200 rounded-xl bg-white p-10 text-center">
          <p className="text-sm font-semibold text-slate-700">
            {total === 0 && !hasFilters ? "No leads yet" : "No matching leads"}
          </p>
          <p className="text-xs text-slate-500 mt-2 max-w-md mx-auto">
            {total === 0 && !hasFilters
              ? `When a dealer submits Section G with ${tenant.display_name} picked, the lead will land here automatically.`
              : "Try widening or resetting the filters."}
          </p>
        </div>
      ) : (
        <div className="border border-slate-200 rounded-xl bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Lead</th>
                <th className="px-4 py-3 text-left font-semibold">Customer</th>
                <th className="px-4 py-3 text-left font-semibold">Location</th>
                <th className="px-4 py-3 text-left font-semibold">Residence</th>
                <th className="px-4 py-3 text-right font-semibold">
                  Asset price
                </th>
                <th className="px-4 py-3 text-left font-semibold">Dealer</th>
                <th className="px-4 py-3 text-left font-semibold">Status</th>
                <th className="px-4 py-3 text-left font-semibold">Assigned</th>
              </tr>
            </thead>
            <tbody>
              {slice.map((r) => (
                <tr
                  key={r.assignment_id}
                  className="border-t border-slate-100 hover:bg-slate-50 transition"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/nbfc/acquire/${r.lead_id}`}
                      className="text-[color:var(--color-brand-sky)] font-semibold hover:underline"
                    >
                      {r.lead_id}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-800">
                      {r.customer_name ?? "—"}
                    </div>
                    <div className="text-xs text-slate-500">
                      {r.customer_phone ?? ""}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {[r.city, r.state].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-700 capitalize">
                    {r.resident_status ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-700">
                    {fmtInr(r.final_price)}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    <div className="text-sm">{r.dealer_name ?? "—"}</div>
                    <div className="text-xs text-slate-400">
                      {r.dealer_code}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-2 py-1 rounded-md text-[11px] font-bold border ${
                        STATUS_TONE[r.assignment_status] ??
                        "bg-slate-50 text-slate-600 border-slate-200"
                      }`}
                    >
                      {STATUS_LABEL[r.assignment_status] ?? r.assignment_status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {relativeTime(r.assigned_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > 0 && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span className="tabular-nums">
            {(safePage - 1) * pageSize + 1}–
            {Math.min(safePage * pageSize, total)} of {total}
          </span>
          <div className="flex gap-1">
            <Link
              href={urlFor({ page: String(Math.max(1, safePage - 1)) })}
              className={`rounded border border-slate-200 px-2 py-1 ${
                safePage === 1
                  ? "pointer-events-none opacity-30"
                  : "hover:bg-slate-50"
              }`}
            >
              ← Prev
            </Link>
            <Link
              href={urlFor({ page: String(Math.min(totalPages, safePage + 1)) })}
              className={`rounded border border-slate-200 px-2 py-1 ${
                safePage === totalPages
                  ? "pointer-events-none opacity-30"
                  : "hover:bg-slate-50"
              }`}
            >
              Next →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
