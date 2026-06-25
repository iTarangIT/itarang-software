/**
 * /nbfc/leads — Lead Intelligence (E-028, BRD §6.1.4)
 *
 * Read-only listing of leads referred to the NBFC. Joins:
 *   - nbfc_loans (tenant scope, vehicleno, dpd, outstanding)
 *   - loan_sanctions (loan amount, file no, status, product link)
 *   - leads (reference, customer, geography)
 *   - product_selections (financed product model)
 *   - loan_files (legacy EMI-status columns, optional)
 *   - borrower_risk_scores (latest cds_score per loan, best-effort)
 * with URL-driven filters: status, q, band, state, product, from/to, sort,
 * page, page_size. The list + read-only detail drawer render through the
 * responsive `LeadsTable` client component.
 */
import Link from "next/link";
import { db } from "@/lib/db";
import { eq, inArray, sql } from "drizzle-orm";
import {
  dealers,
  leads,
  loanFiles,
  loanSanctions,
  nbfcLoans,
  nbfcRiskRules,
  productSelections,
} from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import LeadsTable, { type LeadRow } from "./_components/LeadsTable";
import LeadsCsvButton from "./_components/LeadsCsvButton";

export const dynamic = "force-dynamic";

interface SearchParams {
  status?: string;
  q?: string;
  band?: "low" | "mid" | "high" | string;
  state?: string;
  product?: string;
  dealer?: string;
  dpd?: string;
  emi?: string;
  amount_min?: string;
  amount_max?: string;
  from?: string;
  to?: string;
  sort?: string;
  page?: string;
  page_size?: string;
}

// BRD §6.1.4 — Status values: Sanctioned | Dealer Approved | Disbursed |
// Active | Closed | Overdue.
const STAGES = [
  { id: "sanctioned", label: "Sanctioned", match: ["sanctioned"] },
  { id: "dealer_approved", label: "Dealer Approved", match: ["dealer_approved"] },
  { id: "disbursed", label: "Disbursed", match: ["disbursed"] },
  // "Active" = the whole live book (money out, not yet closed): disbursed +
  // overdue, plus any literal "active" status. This mirrors the Portfolio
  // page's Active Loans count (disbursed AND closed_at IS NULL) so the two
  // pages agree. Disbursed/Overdue remain as lifecycle sub-buckets below.
  { id: "active", label: "Active", match: ["active", "disbursed", "overdue"] },
  { id: "overdue", label: "Overdue", match: ["overdue"] },
  { id: "closed", label: "Closed", match: ["closed", "foreclosed"] },
];

const PAGE_SIZE_OPTIONS = [20, 50, 100];

// DPD severity buckets for the filter bar. `current_dpd` comes from nbfc_loans;
// a null DPD is treated as 0 (current / not delinquent).
const DPD_BUCKETS = [
  { id: "0", label: "Current (0 days)", test: (d: number) => d <= 0 },
  { id: "1-30", label: "1–30 days", test: (d: number) => d >= 1 && d <= 30 },
  { id: "31-60", label: "31–60 days", test: (d: number) => d >= 31 && d <= 60 },
  { id: "60+", label: "60+ days", test: (d: number) => d > 60 },
];

// EMI status filter options, derived from the emi_schedules rollup.
const EMI_STATUS_OPTIONS = [
  { id: "overdue", label: "Overdue" },
  { id: "upcoming", label: "Upcoming" },
  { id: "none", label: "No schedule" },
];

interface CdsBands {
  low_mid: number;
  mid_high: number;
}

async function loadCdsBands(): Promise<CdsBands> {
  const rows = await db
    .select({
      rule_key: nbfcRiskRules.rule_key,
      current_value: nbfcRiskRules.current_value,
    })
    .from(nbfcRiskRules)
    .where(
      inArray(nbfcRiskRules.rule_key, [
        "cds_low_mid_threshold",
        "cds_mid_high_threshold",
      ]),
    );
  const map = new Map(rows.map((r) => [r.rule_key, Number(r.current_value)]));
  return {
    low_mid: map.get("cds_low_mid_threshold") ?? 40,
    mid_high: map.get("cds_mid_high_threshold") ?? 70,
  };
}

function cdsBand(
  score: number | null,
  bands: CdsBands,
): "low" | "mid" | "high" | "na" {
  if (score == null) return "na";
  if (score < bands.low_mid) return "low";
  if (score < bands.mid_high) return "mid";
  return "high";
}

// Sort options for the filter bar. `created_desc` is the default.
const SORT_OPTIONS = [
  { id: "created_desc", label: "Newest first" },
  { id: "created_asc", label: "Oldest first" },
  { id: "amount_desc", label: "Loan amount: high → low" },
  { id: "amount_asc", label: "Loan amount: low → high" },
  { id: "cds_desc", label: "CDS score: high → low" },
  { id: "cds_asc", label: "CDS score: low → high" },
  { id: "name_asc", label: "Customer name: A → Z" },
  { id: "overdue_desc", label: "Most overdue first" },
  { id: "dpd_desc", label: "Current DPD: high → low" },
  { id: "emi_date_asc", label: "Next EMI date: soonest first" },
];

function sortLeads(rows: LeadRow[], key: string): LeadRow[] {
  const out = [...rows];
  const ts = (r: LeadRow) =>
    r.created_at ? new Date(r.created_at).getTime() : 0;
  switch (key) {
    case "created_asc":
      return out.sort((a, b) => ts(a) - ts(b));
    case "amount_desc":
      return out.sort((a, b) => (b.loan_amount ?? -1) - (a.loan_amount ?? -1));
    case "amount_asc":
      return out.sort(
        (a, b) =>
          (a.loan_amount ?? Infinity) - (b.loan_amount ?? Infinity),
      );
    case "cds_desc":
      return out.sort((a, b) => (b.cds_score ?? -1) - (a.cds_score ?? -1));
    case "cds_asc":
      return out.sort(
        (a, b) => (a.cds_score ?? Infinity) - (b.cds_score ?? Infinity),
      );
    case "name_asc":
      return out.sort((a, b) =>
        (a.full_name ?? "").localeCompare(b.full_name ?? ""),
      );
    case "overdue_desc":
      return out.sort((a, b) => (b.overdue_days ?? -1) - (a.overdue_days ?? -1));
    case "dpd_desc":
      return out.sort((a, b) => (b.current_dpd ?? -1) - (a.current_dpd ?? -1));
    case "emi_date_asc": {
      const emiTs = (r: LeadRow) =>
        r.next_emi_date ? new Date(r.next_emi_date).getTime() : Infinity;
      return out.sort((a, b) => emiTs(a) - emiTs(b));
    }
    case "created_desc":
    default:
      return out.sort((a, b) => ts(b) - ts(a));
  }
}

/** Normalises the raw ?sort= param; `cds` is a legacy drill-through alias. */
function resolveSortKey(raw: string | undefined): string {
  if (raw === "cds") return "cds_desc";
  if (raw && SORT_OPTIONS.some((o) => o.id === raw)) return raw;
  return "created_desc";
}

const FIELD_LABEL =
  "block text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)] mb-1";
const FIELD_INPUT =
  "border border-[color:var(--color-border)] rounded-lg px-2.5 py-1.5 text-sm bg-[color:var(--color-surface)]";

export default async function NbfcLeadsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const tenant = await getCurrentTenant();
  await requireNbfcAccess(tenant.id);
  const params = (await searchParams) ?? {};

  const bands = await loadCdsBands();

  const page = Math.max(1, Number(params.page ?? 1));
  const pageSize = Math.min(100, Math.max(20, Number(params.page_size ?? 20)));

  const allRows = (await db
    .select({
      loan_application_id: nbfcLoans.loan_application_id,
      vehicleno: nbfcLoans.vehicleno,
      current_dpd: nbfcLoans.current_dpd,
      outstanding_amount: nbfcLoans.outstanding_amount,
      sanction_id: loanSanctions.id,
      loan_amount: loanSanctions.loan_amount,
      loan_file_number: loanSanctions.loan_file_number,
      sanction_status: loanSanctions.status,
      recovery_flagged_at: loanSanctions.recovery_flagged_at,
      sanctioned_at: loanSanctions.sanctioned_at,
      lead_id: loanSanctions.lead_id,
      reference_id: leads.reference_id,
      // Fall back to owner_name — some lead rows carry only one of the two.
      full_name: sql<string | null>`coalesce(${leads.full_name}, ${leads.owner_name})`,
      city: leads.city,
      state: leads.state,
      dealer_name: dealers.company_name,
      // Financed product: the sanction's product_selection, else the lead's
      // recorded asset model.
      product_model: sql<string | null>`coalesce(${productSelections.model_number}, ${leads.asset_model})`,
      loan_files_status: loanFiles.loan_status,
    })
    .from(nbfcLoans)
    .leftJoin(loanSanctions, eq(loanSanctions.id, nbfcLoans.loan_application_id))
    .leftJoin(leads, eq(leads.id, loanSanctions.lead_id))
    .leftJoin(dealers, eq(dealers.dealer_id, leads.dealer_id))
    .leftJoin(
      productSelections,
      eq(productSelections.id, loanSanctions.product_selection_id),
    )
    .leftJoin(
      loanFiles,
      eq(loanFiles.loan_application_id, nbfcLoans.loan_application_id),
    )
    .where(eq(nbfcLoans.tenant_id, tenant.id))) as Array<{
    loan_application_id: string;
    vehicleno: string | null;
    current_dpd: number | null;
    outstanding_amount: string | null;
    sanction_id: string | null;
    loan_amount: string | null;
    loan_file_number: string | null;
    sanction_status: string | null;
    recovery_flagged_at: Date | null;
    sanctioned_at: Date | null;
    lead_id: string | null;
    reference_id: string | null;
    full_name: string | null;
    city: string | null;
    state: string | null;
    dealer_name: string | null;
    product_model: string | null;
    loan_files_status: string | null;
  }>;

  // Latest CDS per loan_sanction_id (BRD §6.1.4 — "computed nightly").
  // borrower_risk_scores.loan_sanction_id is uuid; cast to text so it matches
  // the varchar loan_sanctions.id. Degrades cleanly to "—" when a loan has no
  // computed score yet.
  const cdsRows = (await db.execute(sql`
    SELECT DISTINCT ON (loan_sanction_id) loan_sanction_id::text AS loan_sanction_id, cds_score::float AS cds_score
    FROM borrower_risk_scores
    WHERE tenant_id = ${tenant.id}
    ORDER BY loan_sanction_id, computed_at DESC
  `)) as unknown as Array<{
    loan_sanction_id: string;
    cds_score: number | null;
  }>;
  const cdsBySanction = new Map(
    cdsRows.map((r) => [r.loan_sanction_id, r.cds_score]),
  );

  // EMI status per loan, derived from the emi_schedules ledger:
  // overdue_days = worst overdue/missed instalment; next_emi_date = the
  // earliest upcoming scheduled instalment. emi_schedules.loan_sanction_id is
  // varchar = loan_sanctions.id — a clean join, no cast.
  const emiRows = (await db.execute(sql`
    SELECT es.loan_sanction_id AS loan_sanction_id,
           MAX(es.days_overdue) FILTER (WHERE es.status IN ('overdue', 'missed'))::int AS overdue_days,
           MIN(es.due_date) FILTER (WHERE es.status = 'scheduled' AND es.due_date >= CURRENT_DATE)::text AS next_emi_date
    FROM emi_schedules es
    JOIN loan_sanctions ls ON ls.id = es.loan_sanction_id
    WHERE ls.nbfc_id = ${tenant.id}
    GROUP BY es.loan_sanction_id
  `)) as unknown as Array<{
    loan_sanction_id: string;
    overdue_days: number | null;
    next_emi_date: string | null;
  }>;
  const emiBySanction = new Map(
    emiRows.map((r) => [
      r.loan_sanction_id,
      { overdue_days: r.overdue_days, next_emi_date: r.next_emi_date },
    ]),
  );

  const statusFilter = params.status?.toLowerCase();
  const bandFilter = params.band?.toLowerCase();
  const stateFilter = params.state?.trim() ?? "";
  const productFilter = params.product?.trim() ?? "";
  const dealerFilter = params.dealer?.trim() ?? "";
  const dpdFilter = params.dpd?.trim() ?? "";
  const emiFilter = params.emi?.trim().toLowerCase() ?? "";
  const amountMinRaw = Number(params.amount_min);
  const amountMaxRaw = Number(params.amount_max);
  const amountMin =
    params.amount_min && !Number.isNaN(amountMinRaw) ? amountMinRaw : null;
  const amountMax =
    params.amount_max && !Number.isNaN(amountMaxRaw) ? amountMaxRaw : null;
  const q = params.q?.toLowerCase().trim() ?? "";
  const from = params.from ? new Date(params.from).getTime() : null;
  const to = params.to
    ? new Date(params.to).getTime() + 24 * 3600 * 1000 - 1
    : null;

  const enriched: LeadRow[] = allRows.map((r) => {
    const cds = r.sanction_id
      ? cdsBySanction.get(r.sanction_id) ?? null
      : null;
    const emi = r.sanction_id ? emiBySanction.get(r.sanction_id) : undefined;
    const baseStatus = (
      r.sanction_status ??
      r.loan_files_status ??
      ""
    ).toLowerCase();
    const effective_status =
      (r.current_dpd ?? 0) > 0 &&
      (baseStatus === "active" || baseStatus === "disbursed")
        ? "overdue"
        : baseStatus;
    return {
      loan_application_id: r.loan_application_id,
      sanction_id: r.sanction_id,
      lead_id: r.lead_id,
      reference_id: r.reference_id,
      full_name: r.full_name,
      dealer_name: r.dealer_name,
      battery_serial: r.vehicleno,
      loan_amount: r.loan_amount != null ? Number(r.loan_amount) : null,
      loan_file_number: r.loan_file_number,
      status: effective_status,
      recovery_flagged: r.recovery_flagged_at != null,
      recovery_flagged_at: r.recovery_flagged_at
        ? r.recovery_flagged_at.toISOString()
        : null,
      current_dpd: r.current_dpd,
      outstanding_amount:
        r.outstanding_amount != null ? Number(r.outstanding_amount) : null,
      overdue_days: emi?.overdue_days ?? null,
      next_emi_date: emi?.next_emi_date ?? null,
      created_at: r.sanctioned_at ? r.sanctioned_at.toISOString() : null,
      cds_score: cds,
      cds_band: cdsBand(cds, bands),
      city: r.city,
      state: r.state,
      product_model: r.product_model,
    };
  });

  // Distinct geography + product values for the filter dropdowns.
  const stateOptions = Array.from(
    new Set(enriched.map((r) => r.state).filter((v): v is string => !!v)),
  ).sort();
  const productOptions = Array.from(
    new Set(
      enriched.map((r) => r.product_model).filter((v): v is string => !!v),
    ),
  ).sort();
  const dealerOptions = Array.from(
    new Set(
      enriched.map((r) => r.dealer_name).filter((v): v is string => !!v),
    ),
  ).sort();

  let filtered = enriched.filter((r) => {
    if (statusFilter) {
      const stage = STAGES.find((s) => s.id === statusFilter);
      if (stage && !stage.match.includes(r.status)) return false;
    }
    if (bandFilter && r.cds_band !== bandFilter) return false;
    if (stateFilter && r.state !== stateFilter) return false;
    if (productFilter && r.product_model !== productFilter) return false;
    if (dealerFilter && r.dealer_name !== dealerFilter) return false;
    if (dpdFilter) {
      const bucket = DPD_BUCKETS.find((b) => b.id === dpdFilter);
      if (bucket && !bucket.test(r.current_dpd ?? 0)) return false;
    }
    // A null loan amount can't satisfy a min/max bound — exclude it when set.
    if (amountMin != null && (r.loan_amount ?? -Infinity) < amountMin)
      return false;
    if (amountMax != null && (r.loan_amount ?? Infinity) > amountMax)
      return false;
    if (emiFilter) {
      const isOverdue = r.overdue_days != null && r.overdue_days > 0;
      const isUpcoming = !isOverdue && !!r.next_emi_date;
      if (emiFilter === "overdue" && !isOverdue) return false;
      if (emiFilter === "upcoming" && !isUpcoming) return false;
      if (emiFilter === "none" && (isOverdue || isUpcoming)) return false;
    }
    if (q) {
      const hay =
        `${r.reference_id ?? ""} ${r.loan_application_id} ${r.battery_serial ?? ""} ${r.full_name ?? ""} ${r.dealer_name ?? ""} ${r.loan_file_number ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const created = r.created_at ? new Date(r.created_at).getTime() : 0;
    if (from != null && created < from) return false;
    if (to != null && created > to) return false;
    return true;
  });

  // Sort the full filtered set before pagination, so both the visible page
  // and the CSV export honour the chosen order.
  const sortKey = resolveSortKey(params.sort);
  filtered = sortLeads(filtered, sortKey);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const slice = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const stageCounts = STAGES.map((s) => ({
    ...s,
    count: enriched.filter((r) => s.match.includes(r.status)).length,
  }));

  function urlFor(overrides: Partial<SearchParams>): string {
    const next = new URLSearchParams();
    const merged = { ...params, ...overrides };
    for (const [k, v] of Object.entries(merged)) {
      if (v != null && v !== "") next.set(k, String(v));
    }
    return `/nbfc/leads?${next.toString()}`;
  }

  const hasFilters = Boolean(
    params.status ||
      params.band ||
      params.state ||
      params.product ||
      params.dealer ||
      params.dpd ||
      params.emi ||
      params.amount_min ||
      params.amount_max ||
      params.q ||
      params.from ||
      params.to ||
      params.sort,
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="section-label-muted">Lead Intelligence</p>
          <h1 className="mt-1 text-2xl font-semibold text-[color:var(--color-brand-navy)]">
            Leads referred via iTarang
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
            Status tracking from disbursal through closure — filter by status,
            geography, product, CDS band and date. Tap any row for the full
            read-only detail.
          </p>
        </div>
        <LeadsCsvButton rows={filtered} />
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {stageCounts.map((s) => (
          <Link
            key={s.id}
            href={urlFor({ status: params.status === s.id ? "" : s.id, page: "1" })}
            className={`card-iTarang p-4 transition ${
              params.status === s.id
                ? "ring-2 ring-[color:var(--color-brand-navy)]"
                : "hover:border-slate-300"
            }`}
          >
            <p className="section-label-muted">{s.label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
              {s.count}
            </p>
          </Link>
        ))}
      </section>

      <form className="card-iTarang flex flex-wrap items-end gap-3 p-3">
        <div>
          <label className={FIELD_LABEL}>CDS band</label>
          <select name="band" defaultValue={params.band ?? ""} className={FIELD_INPUT}>
            <option value="">All</option>
            <option value="low">Low (&lt;{bands.low_mid})</option>
            <option value="mid">
              Mid ({bands.low_mid}–{bands.mid_high})
            </option>
            <option value="high">High (≥{bands.mid_high})</option>
            <option value="na">No score</option>
          </select>
        </div>
        <div>
          <label className={FIELD_LABEL}>Geography</label>
          <select name="state" defaultValue={params.state ?? ""} className={FIELD_INPUT}>
            <option value="">All states</option>
            {stateOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={FIELD_LABEL}>Product</label>
          <select
            name="product"
            defaultValue={params.product ?? ""}
            className={FIELD_INPUT}
          >
            <option value="">All products</option>
            {productOptions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
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
          <label className={FIELD_LABEL}>DPD bucket</label>
          <select name="dpd" defaultValue={params.dpd ?? ""} className={FIELD_INPUT}>
            <option value="">All DPD</option>
            {DPD_BUCKETS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={FIELD_LABEL}>EMI status</label>
          <select name="emi" defaultValue={params.emi ?? ""} className={FIELD_INPUT}>
            <option value="">All</option>
            {EMI_STATUS_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={FIELD_LABEL}>Loan amount (₹)</label>
          <div className="flex items-center gap-1">
            <input
              type="number"
              name="amount_min"
              defaultValue={params.amount_min ?? ""}
              placeholder="Min"
              min={0}
              className={`${FIELD_INPUT} w-24`}
            />
            <span className="text-[color:var(--color-ink-muted)]">–</span>
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
        <div>
          <label className={FIELD_LABEL}>Created from</label>
          <input
            type="date"
            name="from"
            defaultValue={params.from ?? ""}
            className={FIELD_INPUT}
          />
        </div>
        <div>
          <label className={FIELD_LABEL}>Created to</label>
          <input
            type="date"
            name="to"
            defaultValue={params.to ?? ""}
            className={FIELD_INPUT}
          />
        </div>
        <div className="min-w-[200px] flex-1">
          <label className={FIELD_LABEL}>Search</label>
          <input
            type="search"
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Loan, serial, borrower, file no."
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
            href="/nbfc/leads"
            className="self-center text-xs text-[color:var(--color-ink-muted)] underline"
          >
            Reset
          </Link>
        )}
      </form>

      <LeadsTable rows={slice} bands={bands} />

      <div className="flex items-center justify-between text-xs text-[color:var(--color-ink-muted)]">
        <span className="tabular-nums">
          {total === 0 ? 0 : (safePage - 1) * pageSize + 1}–
          {Math.min(safePage * pageSize, total)} of {total}
        </span>
        <div className="flex gap-1">
          <Link
            href={urlFor({ page: String(Math.max(1, safePage - 1)) })}
            className={`rounded border border-[color:var(--color-border)] px-2 py-1 ${
              safePage === 1
                ? "pointer-events-none opacity-30"
                : "hover:bg-[color:var(--color-bg)]"
            }`}
          >
            ← Prev
          </Link>
          <Link
            href={urlFor({ page: String(Math.min(totalPages, safePage + 1)) })}
            className={`rounded border border-[color:var(--color-border)] px-2 py-1 ${
              safePage === totalPages
                ? "pointer-events-none opacity-30"
                : "hover:bg-[color:var(--color-bg)]"
            }`}
          >
            Next →
          </Link>
        </div>
      </div>
    </div>
  );
}
