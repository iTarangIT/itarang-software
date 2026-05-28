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

// Acquire queue — Addendum V0.1 §6.
// Lists nbfc_lead_assignments rows for the current tenant. Read-only in A1;
// per-assignment actions (FI, Video KYC, E-NACH, Offer) land in A3/A4/A6.

export const dynamic = "force-dynamic";

const STATUS_FILTERS = [
  { id: undefined, label: "All" },
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

function relativeTime(ts: Date | null): string {
  if (!ts) return "—";
  const diffMs = Date.now() - new Date(ts).getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function fmtInr(v: string | null | undefined): string {
  if (!v) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export default async function AcquireQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const tenant = await getCurrentTenant();
  const { status } = await searchParams;

  const rows = await db
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
      product_category: leads.product_category_id,
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
    .where(
      and(
        eq(nbfcLeadAssignments.tenant_id, tenant.id),
        status ? eq(nbfcLeadAssignments.status, status) : undefined,
      ),
    )
    .orderBy(desc(nbfcLeadAssignments.assigned_at))
    .limit(100);

  return (
    <div className="px-6 py-8 space-y-6">
      <header>
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

      <nav className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => {
          const active = (status ?? undefined) === f.id;
          const href = f.id ? `/nbfc/acquire?status=${f.id}` : "/nbfc/acquire";
          return (
            <Link
              key={f.label}
              href={href}
              className={`px-3 py-1.5 text-xs font-bold rounded-full border transition ${
                active
                  ? "bg-[color:var(--color-brand-navy)] text-white border-[color:var(--color-brand-navy)]"
                  : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <div className="border border-slate-200 rounded-xl bg-white p-10 text-center">
          <p className="text-sm font-semibold text-slate-700">No leads yet</p>
          <p className="text-xs text-slate-500 mt-2 max-w-md mx-auto">
            When a dealer submits Section G with {tenant.display_name} picked,
            the lead will land here automatically.
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
                <th className="px-4 py-3 text-right font-semibold">Asset price</th>
                <th className="px-4 py-3 text-left font-semibold">Dealer</th>
                <th className="px-4 py-3 text-left font-semibold">Status</th>
                <th className="px-4 py-3 text-left font-semibold">Assigned</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
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
                    <div className="text-xs text-slate-400">{r.dealer_code}</div>
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
    </div>
  );
}
