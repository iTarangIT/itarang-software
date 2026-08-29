import Link from "next/link";

import { DEFAULT_HOURS, type LogFilters } from "@/lib/operations/logs";

/**
 * The explorer's filters, as a plain GET form.
 *
 * No client component, no state, no fetch. Submitting navigates, which means
 * every filtered view has a URL you can paste into an incident thread — the
 * single most useful property this page can have. It also means the page works
 * with JavaScript still loading, which is not a hypothetical on a console
 * someone opens while the site is struggling.
 */

const WINDOWS = [
  { value: 1, label: "1 hour" },
  { value: 6, label: "6 hours" },
  { value: 24, label: "24 hours" },
  { value: 72, label: "3 days" },
  { value: 336, label: "14 days" },
];

const inputClass =
  "h-8 rounded-lg border border-border bg-surface px-2 text-xs text-ink focus:border-brand-sky focus:outline-none";

export function LogFilterBar({
  filters,
  facets,
  exportHref,
}: {
  filters: LogFilters;
  facets: { hosts: string[]; services: string[] };
  exportHref: string;
}) {
  return (
    <form
      method="get"
      action="/operations/logs"
      className="flex flex-wrap items-end gap-2"
    >
      {/* Drilling into one error group is a filter like any other, so it rides
          in a hidden field and survives a re-submit of the form. */}
      {filters.fingerprint && (
        <input type="hidden" name="fingerprint" value={filters.fingerprint} />
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
          Search
        </span>
        <input
          type="search"
          name="q"
          defaultValue={filters.q ?? ""}
          placeholder="message contains…"
          className={`${inputClass} w-56`}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
          Host
        </span>
        <select name="host" defaultValue={filters.host ?? ""} className={inputClass}>
          <option value="">All hosts</option>
          {facets.hosts.map((host) => (
            <option key={host} value={host}>
              {host}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
          Service
        </span>
        <select
          name="service"
          defaultValue={filters.service ?? ""}
          className={`${inputClass} max-w-[12rem]`}
        >
          <option value="">All services</option>
          {facets.services.map((service) => (
            <option key={service} value={service}>
              {service}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
          Level
        </span>
        <select name="level" defaultValue={filters.level ?? ""} className={inputClass}>
          <option value="">All levels</option>
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="info">info</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
          Window
        </span>
        <select
          name="hours"
          defaultValue={String(filters.hours ?? DEFAULT_HOURS)}
          className={inputClass}
        >
          {WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
      </label>

      <button
        type="submit"
        className="h-8 rounded-lg bg-brand-navy px-3 text-xs font-semibold text-white hover:opacity-90"
      >
        Apply
      </button>

      <Link
        href="/operations/logs"
        className="h-8 rounded-lg border border-border px-3 text-xs font-semibold leading-8 text-ink-muted hover:bg-brand-50"
      >
        Reset
      </Link>

      <Link
        href={exportHref}
        prefetch={false}
        className="ml-auto h-8 rounded-lg border border-border px-3 text-xs font-semibold leading-8 text-ink-muted hover:bg-brand-50"
      >
        Export .xlsx
      </Link>
    </form>
  );
}
