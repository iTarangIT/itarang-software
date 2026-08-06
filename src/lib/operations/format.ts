/**
 * Unit formatting shared by the Ops Console pages, the Excel export and the
 * alert emails.
 *
 * One implementation so a threshold breach reads the same in the email as it
 * does on the page it links to — the failure mode being an alert that says
 * "disk at 0.91" against a dashboard that says "91%".
 */

import { formatINR } from "@/lib/currency";

import type { MetricUnit } from "./registry";

/**
 * A sample's value_num arrives from Drizzle as a string, because Postgres
 * `numeric` is returned as text to avoid the float precision loss that would
 * come from parsing it as a JS number. Every read path goes through here.
 */
export function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const sign = bytes < 0 ? "-" : "";
  // Bytes and KB are never fractional in practice; larger units need one
  // decimal or a 1.9 GB volume reads as "2 GB".
  const decimals = unit <= 1 ? 0 : 1;
  return `${sign}${value.toFixed(decimals)} ${units[unit]}`;
}

export function formatPercent(value: number | null): string {
  if (value == null) return "—";
  // Percents are stored 0-100. One decimal below 10 so a creeping 2.4% is not
  // flattened to 2%, none above — nobody needs 87.3% CPU to a tenth.
  return value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

export function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function formatCount(value: number | null): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-IN").format(value);
}

/**
 * Durations expressed in whole units, for "last ran 3h 12m ago". Deliberately
 * two units at most — "3h 12m" is actionable, "3h 12m 7s" is noise.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;

  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;

  const h = Math.floor(m / 60);
  if (h < 24) return h > 0 && m % 60 > 0 ? `${h}h ${m % 60}m` : `${h}h`;

  const d = Math.floor(h / 24);
  return h % 24 > 0 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function formatMinutesAgo(minutes: number | null): string {
  if (minutes == null) return "never";
  return `${formatDuration(minutes * 60)} ago`;
}

/** The one entry point pages should call: format by the metric's declared unit. */
export function formatMetricValue(
  value: number | null,
  unit: MetricUnit,
): string {
  if (value == null) return "—";
  switch (unit) {
    case "percent":
      return formatPercent(value);
    case "bytes":
      return formatBytes(value);
    case "ms":
      return formatMs(value);
    case "inr_paise":
      // Already INR paise for every provider — formatINR only divides by 100.
      // Never apply an FX rate here; see src/lib/currency.ts.
      return formatINR(value);
    case "credits":
      return `${formatCount(value)} cr`;
    case "bool":
      return value >= 1 ? "Yes" : "No";
    case "days":
      return `${formatCount(value)}d`;
    case "count":
    default:
      return formatCount(value);
  }
}

/** IST throughout — the team, the boxes' cron windows and standup are all IST. */
export function formatIst(
  date: Date | string | null,
  opts: { withSeconds?: boolean } = {},
): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: opts.withSeconds ? "medium" : "short",
    timeZone: "Asia/Kolkata",
  }).format(d);
}

export function minutesSince(date: Date | string | null): number | null {
  if (!date) return null;
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / 60_000;
}
