/**
 * /nbfc/leads — Lead Intelligence (E-028, BRD §6.1.4)
 *
 * Read-only listing of leads referred to the NBFC. Joins:
 *   - nbfc_loans (tenant scope, vehicleno, dpd, outstanding)
 *   - loan_files (borrower_name, loan_status, total_outstanding, next_emi_date, overdue_days)
 *   - borrower_risk_scores (latest cds_score per loan_application_id, best-effort)
 * with URL-driven filters: status, q (text), band (cds), from/to (date), page, page_size.
 */
import Link from "next/link";
import { db } from "@/lib/db";
import { eq, inArray, sql } from "drizzle-orm";
import { nbfcLoans, loanFiles, nbfcRiskRules } from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";

export const dynamic = "force-dynamic";

interface SearchParams {
  status?: string;
  q?: string;
  band?: "low" | "mid" | "high" | string;
  from?: string;
  to?: string;
  page?: string;
  page_size?: string;
}

const STAGES = [
  { id: "active", label: "Active", match: ["active"] },
  { id: "overdue", label: "Overdue", match: ["overdue"] },
  { id: "disbursed", label: "Disbursed", match: ["active", "overdue"] },
  { id: "closed", label: "Closed", match: ["closed", "foreclosed"] },
  { id: "pending", label: "Pending Disb.", match: ["pending"] },
];

const PAGE_SIZE_OPTIONS = [20, 50, 100];

interface CdsBands {
  low_mid: number;
  mid_high: number;
}

async function loadCdsBands(): Promise<CdsBands> {
  const rows = await db
    .select({ rule_key: nbfcRiskRules.rule_key, current_value: nbfcRiskRules.current_value })
    .from(nbfcRiskRules)
    .where(inArray(nbfcRiskRules.rule_key, ["cds_low_mid_threshold", "cds_mid_high_threshold"]));
  const map = new Map(rows.map((r) => [r.rule_key, Number(r.current_value)]));
  return {
    low_mid: map.get("cds_low_mid_threshold") ?? 40,
    mid_high: map.get("cds_mid_high_threshold") ?? 70,
  };
}

function cdsBand(score: number | null, bands: CdsBands): "low" | "mid" | "high" | "na" {
  if (score == null) return "na";
  if (score < bands.low_mid) return "low";
  if (score < bands.mid_high) return "mid";
  return "high";
}

const BAND_TONE: Record<string, string> = {
  low: "bg-emerald-50 text-emerald-700",
  mid: "bg-amber-50 text-amber-700",
  high: "bg-red-50 text-red-700",
  na: "bg-slate-100 text-slate-500",
};

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

  // Stage counts (always over the unfiltered tenant set so the strip is stable).
  const allRows = (await db
    .select({
      loan_application_id: nbfcLoans.loan_application_id,
      vehicleno: nbfcLoans.vehicleno,
      current_dpd: nbfcLoans.current_dpd,
      outstanding_amount: nbfcLoans.outstanding_amount,
      borrower_name: loanFiles.borrower_name,
      loan_status: loanFiles.loan_status,
      next_emi_date: loanFiles.next_emi_date,
      overdue_days: loanFiles.overdue_days,
      loan_file_number: loanFiles.id,
      created_at: loanFiles.created_at,
    })
    .from(nbfcLoans)
    .leftJoin(loanFiles, eq(loanFiles.loan_application_id, nbfcLoans.loan_application_id))
    .where(eq(nbfcLoans.tenant_id, tenant.id))) as Array<{
    loan_application_id: string;
    vehicleno: string | null;
    current_dpd: number | null;
    outstanding_amount: string | null;
    borrower_name: string | null;
    loan_status: string | null;
    next_emi_date: Date | null;
    overdue_days: number | null;
    loan_file_number: string | null;
    created_at: Date | null;
  }>;

  // Latest CDS score per loan_application_id (best-effort — table is keyed on
  // loan_sanction_id which we don't persistently link to nbfcLoans yet).
  const cdsRows = (await db.execute(sql`
    SELECT DISTINCT ON (loan_sanction_id) loan_sanction_id::text AS loan_sanction_id, cds_score::float AS cds_score
    FROM borrower_risk_scores
    WHERE tenant_id = ${tenant.id}
    ORDER BY loan_sanction_id, computed_at DESC
  `)) as unknown as Array<{ loan_sanction_id: string; cds_score: number | null }>;
  const cdsByLoan = new Map(cdsRows.map((r) => [r.loan_sanction_id, r.cds_score]));

  // Apply filters in JS (set is bounded by tenant size).
  const statusFilter = params.status?.toLowerCase();
  const bandFilter = params.band?.toLowerCase();
  const q = params.q?.toLowerCase().trim() ?? "";
  const from = params.from ? new Date(params.from).getTime() : null;
  const to = params.to ? new Date(params.to).getTime() + 24 * 3600 * 1000 - 1 : null;

  const enriched = allRows.map((r) => {
    const cds = cdsByLoan.get(r.loan_application_id) ?? null;
    return {
      loan_application_id: r.loan_application_id,
      vehicleno: r.vehicleno,
      borrower_name: r.borrower_name,
      loan_file_number: r.loan_file_number,
      loan_status: r.loan_status,
      current_dpd: r.current_dpd,
      outstanding_amount: r.outstanding_amount != null ? Number(r.outstanding_amount) : null,
      overdue_days: r.overdue_days,
      next_emi_date: r.next_emi_date,
      created_at: r.created_at,
      cds_score: cds,
      cds_band: cdsBand(cds, bands),
    };
  });

  const filtered = enriched.filter((r) => {
    if (statusFilter) {
      const stage = STAGES.find((s) => s.id === statusFilter);
      if (stage && !stage.match.includes((r.loan_status ?? "").toLowerCase())) return false;
    }
    if (bandFilter && r.cds_band !== bandFilter) return false;
    if (q) {
      const hay = `${r.loan_application_id} ${r.vehicleno ?? ""} ${r.borrower_name ?? ""} ${r.loan_file_number ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (from != null && (r.created_at?.getTime() ?? 0) < from) return false;
    if (to != null && (r.created_at?.getTime() ?? 0) > to) return false;
    return true;
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const slice = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const stageCounts = STAGES.map((s) => ({
    ...s,
    count: enriched.filter((r) => s.match.includes((r.loan_status ?? "").toLowerCase())).length,
  }));

  function urlFor(overrides: Partial<SearchParams>): string {
    const next = new URLSearchParams();
    const merged = { ...params, ...overrides };
    for (const [k, v] of Object.entries(merged)) {
      if (v != null && v !== "") next.set(k, String(v));
    }
    return `/nbfc/leads?${next.toString()}`;
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="section-label-muted">Lead Intelligence</p>
        <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
          Leads referred via iTarang
        </h1>
        <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
          Status tracking from disbursal through closure, filterable by status, geography,
          product and date.
        </p>
      </header>

      <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {stageCounts.map((s) => (
          <Link
            key={s.id}
            href={urlFor({ status: params.status === s.id ? "" : s.id, page: "1" })}
            className={`card-iTarang p-4 transition ${params.status === s.id ? "ring-2 ring-[color:var(--color-brand-navy)]" : "hover:border-slate-300"}`}
          >
            <p className="section-label-muted">{s.label}</p>
            <p className="mt-2 text-2xl font-semibold text-[color:var(--color-brand-navy)] tabular-nums">
              {s.count}
            </p>
          </Link>
        ))}
      </section>

      <form className="flex flex-wrap items-end gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
            CDS band
          </label>
          <select name="band" defaultValue={params.band ?? ""} className="border rounded px-2 py-1 text-sm">
            <option value="">All</option>
            <option value="low">Low (&lt;{bands.low_mid})</option>
            <option value="mid">Mid ({bands.low_mid}–{bands.mid_high})</option>
            <option value="high">High (≥{bands.mid_high})</option>
            <option value="na">No score</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
            Created from
          </label>
          <input type="date" name="from" defaultValue={params.from ?? ""} className="border rounded px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
            Created to
          </label>
          <input type="date" name="to" defaultValue={params.to ?? ""} className="border rounded px-2 py-1 text-sm" />
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
            Search
          </label>
          <input
            type="search"
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Loan, serial, borrower, file no."
            className="border rounded px-2 py-1 text-sm w-full"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
            Per page
          </label>
          <select name="page_size" defaultValue={String(pageSize)} className="border rounded px-2 py-1 text-sm">
            {PAGE_SIZE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {params.status ? <input type="hidden" name="status" value={params.status} /> : null}
        <button type="submit" className="px-4 py-1.5 text-sm font-bold bg-[color:var(--color-brand-navy)] text-white rounded">
          Apply
        </button>
        {(params.status || params.band || params.q || params.from || params.to) && (
          <Link href="/nbfc/leads" className="text-xs underline text-slate-500 self-center">
            Reset
          </Link>
        )}
      </form>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900 text-xs uppercase tracking-widest text-slate-500">
            <tr>
              <th className="px-3 py-2.5 text-left font-bold">Loan</th>
              <th className="px-3 py-2.5 text-left font-bold">Borrower</th>
              <th className="px-3 py-2.5 text-left font-bold">Battery</th>
              <th className="px-3 py-2.5 text-left font-bold">Status</th>
              <th className="px-3 py-2.5 text-left font-bold">CDS</th>
              <th className="px-3 py-2.5 text-right font-bold">Outstanding</th>
              <th className="px-3 py-2.5 text-left font-bold">EMI status</th>
            </tr>
          </thead>
          <tbody>
            {slice.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-12 text-center text-slate-500 text-sm">
                  No leads match these filters.
                </td>
              </tr>
            ) : (
              slice.map((r) => (
                <tr key={r.loan_application_id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-3 py-2 font-mono text-xs">{r.loan_application_id}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.borrower_name ?? "—"}</div>
                    <div className="text-xs text-slate-500">{r.loan_file_number ?? ""}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.vehicleno ?? "—"}</td>
                  <td className="px-3 py-2 text-xs uppercase font-bold">
                    {r.loan_status ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${BAND_TONE[r.cds_band]}`}>
                      {r.cds_band === "na"
                        ? "—"
                        : `${r.cds_band} · ${r.cds_score?.toFixed(0) ?? "?"}`}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.outstanding_amount != null
                      ? `₹${r.outstanding_amount.toLocaleString("en-IN")}`
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.overdue_days != null && r.overdue_days > 0 ? (
                      <span className="text-red-700 font-bold">{r.overdue_days}d overdue</span>
                    ) : r.next_emi_date ? (
                      <span className="text-slate-500">
                        next {r.next_emi_date.toLocaleDateString()}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span className="tabular-nums">
          {total === 0 ? 0 : (safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, total)} of {total}
        </span>
        <div className="flex gap-1">
          <Link
            href={urlFor({ page: String(Math.max(1, safePage - 1)) })}
            className={`px-2 py-1 rounded border ${safePage === 1 ? "opacity-30 pointer-events-none" : "hover:bg-slate-50"}`}
          >
            ← Prev
          </Link>
          <Link
            href={urlFor({ page: String(Math.min(totalPages, safePage + 1)) })}
            className={`px-2 py-1 rounded border ${safePage === totalPages ? "opacity-30 pointer-events-none" : "hover:bg-slate-50"}`}
          >
            Next →
          </Link>
        </div>
      </div>
    </div>
  );
}

