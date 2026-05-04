/**
 * /nbfc/leads  (E-028 — BRD §6.1.4 Lead Intelligence)
 *
 * Read-only listing of leads referred to the NBFC via iTarang. The full
 * pipeline (KYC -> Sanctioned -> Disbursed -> Active -> Closed) and the
 * filter bar described by E-028 land in follow-up units; this page is the
 * branded shell so the BRD's seven-item navigation is complete from day one.
 */

export const dynamic = "force-dynamic";

const STAGES = [
  { id: "kyc", label: "KYC", count: 0 },
  { id: "sanctioned", label: "Sanctioned", count: 0 },
  { id: "disbursed", label: "Disbursed", count: 0 },
  { id: "active", label: "Active", count: 0 },
  { id: "closed", label: "Closed", count: 0 },
];

export default function NbfcLeadsPage() {
  return (
    <div className="space-y-6">
      <header>
        <p className="section-label-muted">Lead Intelligence</p>
        <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
          Leads referred via iTarang
        </h1>
        <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
          Status tracking from KYC through closure, filterable by status,
          geography, product and date.
        </p>
      </header>

      <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {STAGES.map((s) => (
          <div key={s.id} className="card-iTarang p-4">
            <p className="section-label-muted">{s.label}</p>
            <p className="mt-2 text-2xl font-semibold text-[color:var(--color-brand-navy)] tabular-nums">
              {s.count}
            </p>
          </div>
        ))}
      </section>

      <section className="card-iTarang p-8 text-center">
        <p className="section-label-muted">Pipeline detail</p>
        <h2 className="text-base font-semibold text-[color:var(--color-brand-navy)] mt-2">
          Lead listing lands here
        </h2>
        <p className="text-sm text-[color:var(--color-ink-muted)] max-w-md mx-auto mt-2">
          The filterable lead table (E-028) is delivered by a follow-up unit;
          this surface guarantees the BRD's seven-item navigation is in place
          from the moment an NBFC partner logs in.
        </p>
      </section>
    </div>
  );
}
