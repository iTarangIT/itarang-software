"use client";

/**
 * E-065 — Cross-NBFC comparison table (BRD §6.3.2).
 *
 * Pure presentational. Renders one row per active NBFC with active loans,
 * delinquency %, avg CDS, and recovery rate %.
 */
import type { EcosystemComparisonRow } from "@/lib/nbfc/ecosystem-overview";

type Props = {
  rows: EcosystemComparisonRow[];
};

function fmtInt(n: number): string {
  return new Intl.NumberFormat("en-IN").format(Math.round(n));
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

export default function CrossNbfcComparisonTable({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <div
        className="rounded-md border border-gray-200 bg-white p-4 text-sm text-gray-500"
        data-testid="ecosystem-comparison-empty"
      >
        No active NBFCs to compare.
      </div>
    );
  }

  return (
    <div
      className="overflow-x-auto rounded-md border border-gray-200 bg-white"
      data-testid="ecosystem-comparison"
    >
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-2 text-left font-medium text-gray-700">NBFC</th>
            <th className="px-4 py-2 text-right font-medium text-gray-700">
              Active Loans
            </th>
            <th className="px-4 py-2 text-right font-medium text-gray-700">
              Delinquency %
            </th>
            <th className="px-4 py-2 text-right font-medium text-gray-700">
              Avg CDS
            </th>
            <th className="px-4 py-2 text-right font-medium text-gray-700">
              Recovery Rate
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr
              key={r.nbfc_id}
              data-testid={`ecosystem-row-${r.nbfc_id}`}
              className="hover:bg-gray-50"
            >
              <td className="px-4 py-2 text-left text-gray-900">{r.nbfc_name}</td>
              <td className="px-4 py-2 text-right text-gray-900">
                {fmtInt(r.active_loans)}
              </td>
              <td className="px-4 py-2 text-right text-gray-900">
                {fmtPct(r.delinquency_pct)}
              </td>
              <td className="px-4 py-2 text-right text-gray-900">
                {r.avg_cds.toFixed(1)}
              </td>
              <td className="px-4 py-2 text-right text-gray-900">
                {fmtPct(r.recovery_rate_pct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
