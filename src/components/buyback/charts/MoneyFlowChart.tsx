"use client";

/**
 * Money-flow chart for the admin buyback dashboard: monthly green "Received"
 * bars (vendor receipts, direction IN), amber "Paid out" bars (dealer payouts,
 * direction OUT) and a navy "Margin locked" line, on one shared ₹ axis.
 *
 * Pure presentational — recharts is imported directly here (this file is the
 * lazy-loaded chunk), but nothing from the buyback lib is: ₹ formatting is a
 * local Intl helper so the chart kit stays a leaf. The parent owns the empty
 * state; on empty `data` this renders nothing.
 */

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface MoneyFlowDatum {
  month: string; // 'YYYY-MM'
  received: number;
  paid_out: number;
  margin_locked: number;
}

const GREEN = "#16A34A";
const AMBER = "#F59E0B";
const NAVY = "#0B2239";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** '2026-07' → "Jul '26". Leaves anything unexpected untouched. */
function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const name = MONTHS[Number(m[2]) - 1] ?? month;
  return `${name} '${m[1].slice(2)}`;
}

/** Trim a trailing ".0" so 1.0 → "1" but 1.2 stays "1.2". */
function trim1(n: number): string {
  return String(Number(n.toFixed(1)));
}

/** Compact ₹ axis tick: ₹5k, ₹1.2L (lakh above 1e5), ₹1.2Cr above 1e7. */
function compactInr(value: number): string {
  const n = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (n >= 1e7) return `${sign}₹${trim1(n / 1e7)}Cr`;
  if (n >= 1e5) return `${sign}₹${trim1(n / 1e5)}L`;
  if (n >= 1e3) return `${sign}₹${trim1(n / 1e3)}k`;
  return `${sign}₹${Math.round(n)}`;
}

/** Full Indian-grouped ₹ for the tooltip rows. */
function fullInr(value: number): string {
  const negative = value < 0;
  const formatted = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(
    Math.abs(Math.round(value)),
  );
  return `${negative ? "-" : ""}₹${formatted}`;
}

interface TooltipRow {
  color: string;
  name: string;
  value: number;
}

function MoneyTooltip({
  active,
  label,
  payload,
}: {
  active?: boolean;
  label?: string;
  payload?: Array<{ color?: string; name?: string; value?: number }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const rows: TooltipRow[] = payload.map((p) => ({
    color: p.color ?? "#334155",
    name: p.name ?? "",
    value: Number(p.value ?? 0),
  }));
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] shadow-lg">
      <div className="mb-1 font-semibold text-slate-900">{monthLabel(String(label ?? ""))}</div>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="pr-3 text-slate-500">
                <span
                  className="mr-1.5 inline-block h-2 w-2 rounded-[2px] align-middle"
                  style={{ background: r.color }}
                />
                {r.name}
              </td>
              <td className="text-right font-semibold tabular-nums text-slate-900">
                {fullInr(r.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MoneyFlowChart({
  data,
  height = 260,
}: {
  data: MoneyFlowDatum[];
  height?: number;
}) {
  if (!data || data.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
        <XAxis
          dataKey="month"
          tickFormatter={monthLabel}
          tick={{ fontSize: 11, fill: "#94A3B8" }}
          tickLine={false}
          axisLine={{ stroke: "#E2E8F0" }}
        />
        <YAxis
          tickFormatter={compactInr}
          tick={{ fontSize: 11, fill: "#94A3B8" }}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <Tooltip content={<MoneyTooltip />} cursor={{ fill: "rgba(15,23,42,0.04)" }} />
        <Legend
          verticalAlign="top"
          align="right"
          height={28}
          iconType="circle"
          wrapperStyle={{ fontSize: 12 }}
        />
        <Bar dataKey="received" name="Received" fill={GREEN} radius={[3, 3, 0, 0]} maxBarSize={34} />
        <Bar dataKey="paid_out" name="Paid out" fill={AMBER} radius={[3, 3, 0, 0]} maxBarSize={34} />
        <Line
          type="monotone"
          dataKey="margin_locked"
          name="Margin locked"
          stroke={NAVY}
          strokeWidth={2}
          dot={{ r: 3 }}
          activeDot={{ r: 4 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
