import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  ArrowLeft,
  AlertTriangle,
  CircleDashed,
  Clock,
} from "lucide-react";
import {
  dealers,
  leads,
  nbfc,
  nbfcLeadAssignments,
  nbfcLoanProducts,
  productSelections,
} from "@/lib/db/schema";
import { getCurrentTenant } from "@/lib/nbfc/tenant";

// Acquire lead detail — Addendum V0.1 §6 / §7.
// READ-ONLY in A1. Action surfaces (FI / Video KYC / E-NACH / Offer) land
// in A3/A4/A6 once the supporting tables and per-track storage migrations
// are written.

export const dynamic = "force-dynamic";

function fmtInr(v: string | number | null | undefined): string {
  if (v == null) return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function fmtDate(ts: Date | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type SelectedNbfcPick = { nbfc_id?: string; loan_product_id?: string | number };

export default async function AcquireLeadDetailPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const tenant = await getCurrentTenant();
  const { leadId } = await params;

  // Assignment-ownership guard: this tenant must own a row for this lead.
  const [assignment] = await db
    .select()
    .from(nbfcLeadAssignments)
    .where(
      and(
        eq(nbfcLeadAssignments.lead_id, leadId),
        eq(nbfcLeadAssignments.tenant_id, tenant.id),
      ),
    )
    .limit(1);
  if (!assignment) notFound();

  const [lead] = await db
    .select()
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) notFound();

  const [ps] = await db
    .select()
    .from(productSelections)
    .where(
      and(
        eq(productSelections.lead_id, leadId),
        eq(productSelections.payment_mode, "finance"),
      ),
    )
    .limit(1);

  const [dealerRow] = lead.dealer_id
    ? await db
        .select({
          dealer_id: dealers.dealer_id,
          company_name: dealers.company_name,
          city: dealers.city,
        })
        .from(dealers)
        .where(eq(dealers.dealer_id, lead.dealer_id))
        .limit(1)
    : [];

  // Section G picks — which NBFCs the customer selected, including us.
  const picks =
    (ps?.selected_nbfcs as SelectedNbfcPick[] | null | undefined) ?? [];
  const pickedNbfcIds = picks
    .map((p) => (p?.nbfc_id == null ? NaN : Number(p.nbfc_id)))
    .filter((n) => Number.isFinite(n));

  const pickedNbfcRows = pickedNbfcIds.length
    ? await db
        .select({
          id: nbfc.id,
          short_name: nbfc.short_name,
          legal_name: nbfc.legal_name,
        })
        .from(nbfc)
        .where(inArray(nbfc.id, pickedNbfcIds))
    : [];

  // The current tenant's own nbfc.id — used to highlight "this NBFC" in the
  // Section G list. tenant_id is on nbfc; one tenant -> at most one nbfc row.
  const [myNbfc] = await db
    .select({ id: nbfc.id })
    .from(nbfc)
    .where(eq(nbfc.tenant_id, tenant.id))
    .limit(1);
  const myNbfcId = myNbfc?.id ?? null;

  // Loan product the customer indicated when picking us (if any).
  const [loanProduct] = assignment.loan_product_id
    ? await db
        .select()
        .from(nbfcLoanProducts)
        .where(eq(nbfcLoanProducts.id, assignment.loan_product_id))
        .limit(1)
    : [];

  const batteryPhotos = (ps?.battery_photo_urls as string[] | null) ?? [];
  const chargerPhotos = (ps?.charger_photo_urls as string[] | null) ?? [];

  return (
    <div className="px-6 py-8 space-y-6 max-w-6xl mx-auto">
      <div>
        <Link
          href="/nbfc/acquire"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to pipeline
        </Link>
      </div>

      <div className="border border-amber-200 bg-amber-50 text-amber-900 rounded-lg px-4 py-3 flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <p className="text-xs leading-relaxed">
          Field Investigation and Video KYC are run at this NBFC&apos;s own
          cost. If the customer picks another lender, no per-service refund
          applies.
        </p>
      </div>

      <header className="border border-slate-200 rounded-xl bg-white p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
              Acquire · Lead
            </p>
            <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
              {lead.full_name ?? lead.owner_name ?? "—"}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              <span className="font-mono">{lead.id}</span>
              {" · "}
              {lead.phone ?? "—"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-wider text-slate-400">
              Asset price
            </p>
            <p className="text-xl font-bold text-slate-800">
              {fmtInr(ps?.final_price)}
            </p>
            <p className="text-xs text-slate-500 mt-2">
              Assigned {fmtDate(assignment.assigned_at)}
            </p>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <section className="border border-slate-200 rounded-xl bg-white p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-4">
              Customer
            </h2>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <Field k="Full name" v={lead.full_name} />
              <Field k="Phone" v={lead.phone} />
              <Field
                k="Date of birth"
                v={lead.dob ? fmtDate(lead.dob) : null}
              />
              <Field k="Father / husband" v={lead.father_or_husband_name} />
              <Field k="City" v={lead.city} />
              <Field k="State" v={lead.state} />
              <Field k="Current address" v={lead.current_address} span={2} />
              <Field
                k="Resident status"
                v={
                  lead.resident_status
                    ? lead.resident_status.charAt(0).toUpperCase() +
                      lead.resident_status.slice(1)
                    : null
                }
              />
              <Field
                k="Has health insurance"
                v={
                  lead.has_health_insurance == null
                    ? null
                    : lead.has_health_insurance
                      ? "Yes"
                      : "No"
                }
              />
              <Field
                k="Has life insurance"
                v={
                  lead.has_life_insurance == null
                    ? null
                    : lead.has_life_insurance
                      ? "Yes"
                      : "No"
                }
              />
            </dl>
          </section>

          <section className="border border-slate-200 rounded-xl bg-white p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-4">
              Product Selection
            </h2>
            {ps ? (
              <>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  <Field k="Battery serial" v={ps.battery_serial} />
                  <Field k="Charger serial" v={ps.charger_serial} />
                  <Field k="Category" v={ps.category} />
                  <Field k="Model number" v={ps.model_number} />
                  <Field k="Final price" v={fmtInr(ps.final_price)} />
                  <Field
                    k="Customer disclosure"
                    v={
                      ps.customer_disclosure_ack
                        ? "Acknowledged"
                        : "Not acknowledged"
                    }
                  />
                </dl>

                {(batteryPhotos.length > 0 || chargerPhotos.length > 0) && (
                  <div className="mt-5 space-y-3">
                    {batteryPhotos.length > 0 && (
                      <PhotoStrip title="Battery photos" urls={batteryPhotos} />
                    )}
                    {chargerPhotos.length > 0 && (
                      <PhotoStrip title="Charger photos" urls={chargerPhotos} />
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-slate-500">
                No product selection recorded.
              </p>
            )}
          </section>

          <section className="border border-slate-200 rounded-xl bg-white p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-4">
              Section G — NBFCs the customer picked
            </h2>
            {pickedNbfcRows.length === 0 ? (
              <p className="text-sm text-slate-500">No picks recorded.</p>
            ) : (
              <ul className="space-y-2">
                {pickedNbfcRows.map((n) => {
                  const isUs = myNbfcId !== null && n.id === myNbfcId;
                  return (
                    <li
                      key={n.id}
                      className={`px-3 py-2.5 rounded-lg border text-sm flex items-center justify-between ${
                        isUs
                          ? "border-[color:var(--color-brand-sky)] bg-[color:var(--color-brand-sky)]/5"
                          : "border-slate-200"
                      }`}
                    >
                      <div>
                        <div className="font-semibold text-slate-800">
                          {n.short_name}
                        </div>
                        <div className="text-xs text-slate-500">
                          {n.legal_name}
                        </div>
                      </div>
                      {isUs && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-sky)]">
                          This NBFC
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {loanProduct && (
            <section className="border border-slate-200 rounded-xl bg-white p-5">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-4">
                Indicated Loan Product
              </h2>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <Field k="Product" v={loanProduct.product_name} />
                <Field k="Status" v={loanProduct.status} />
                <Field
                  k="Loan amount"
                  v={`${fmtInr(loanProduct.loan_amount_min)} – ${fmtInr(loanProduct.loan_amount_max)}`}
                />
                <Field
                  k="Tenure (months)"
                  v={`${loanProduct.tenure_months_min} – ${loanProduct.tenure_months_max}`}
                />
                <Field
                  k="ROI (%)"
                  v={`${loanProduct.min_roi_pct} – ${loanProduct.max_roi_pct}`}
                />
                <Field
                  k="Down payment (%)"
                  v={`${loanProduct.down_payment_pct}`}
                />
                <Field
                  k="Disbursement TAT"
                  v={
                    loanProduct.disbursement_tat_hours != null
                      ? `${loanProduct.disbursement_tat_hours}h`
                      : null
                  }
                />
                <Field k="Credit bureau" v={loanProduct.credit_bureau} />
              </dl>
            </section>
          )}
        </div>

        <div className="space-y-5">
          <section className="border border-slate-200 rounded-xl bg-white p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-4">
              Dealer
            </h2>
            <div className="text-sm font-medium text-slate-800">
              {dealerRow?.company_name ?? "—"}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              {dealerRow?.dealer_id ?? lead.dealer_id ?? "—"}
            </div>
            {dealerRow?.city && (
              <div className="text-xs text-slate-500">{dealerRow.city}</div>
            )}
          </section>

          <section className="border border-slate-200 rounded-xl bg-white p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-4">
              Verification Tracks
            </h2>
            <div className="space-y-3">
              <TrackPlaceholder title="Field Investigation" phase="A3" />
              <TrackPlaceholder title="Active Video KYC" phase="A3" />
              <TrackPlaceholder title="E-NACH (winner only)" phase="A6" />
            </div>
          </section>

          <section className="border border-slate-200 rounded-xl bg-white p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-4">
              Financing Offer
            </h2>
            <div className="rounded-lg border-2 border-dashed border-slate-200 p-4 text-center">
              <CircleDashed className="w-5 h-5 text-slate-400 mx-auto" />
              <p className="text-xs font-semibold text-slate-600 mt-2">
                Offer submission lands in A4
              </p>
              <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                Once verification tracks complete, Credit / Underwriting will
                submit firm financing conditions. The customer compares offers
                across selected NBFCs and picks the winner.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Field({
  k,
  v,
  span,
}: {
  k: string;
  v: string | number | null | undefined;
  span?: 1 | 2;
}) {
  return (
    <div className={span === 2 ? "col-span-2" : undefined}>
      <dt className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
        {k}
      </dt>
      <dd className="text-sm text-slate-700 mt-0.5">
        {v == null || v === "" ? <span className="text-slate-300">—</span> : v}
      </dd>
    </div>
  );
}

function PhotoStrip({ title, urls }: { title: string; urls: string[] }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold mb-2">
        {title}
      </p>
      <div className="flex gap-2 flex-wrap">
        {urls.map((u, idx) => (
          <a
            key={idx}
            href={u}
            target="_blank"
            rel="noreferrer"
            className="block w-24 h-24 rounded-md overflow-hidden border border-slate-200 hover:border-[color:var(--color-brand-sky)] transition"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={u} alt="" className="w-full h-full object-cover" />
          </a>
        ))}
      </div>
    </div>
  );
}

function TrackPlaceholder({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-slate-400" />
        <span className="text-sm font-semibold text-slate-800">{title}</span>
      </div>
      <p className="text-[11px] text-slate-500 mt-1">
        Not started · arrives in phase {phase}
      </p>
    </div>
  );
}
