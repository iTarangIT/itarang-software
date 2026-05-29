"use client";

/**
 * Sticky filter bar for the NBFC audit log. Mirrors the BRD §6.3.5 filter set:
 * date range, action type, status, requestedBy, entity id.
 */
import { useEffect, useState } from "react";
import {
  ACTION_CODES,
  ACTION_LABELS,
  EMPTY_FILTERS,
  STATUS_FILTERS,
  type AuditLogFiltersState,
  type AuditLogUser,
} from "./types";

interface Props {
  value: AuditLogFiltersState;
  onChange: (next: AuditLogFiltersState) => void;
  requesters: AuditLogUser[];
  resultCount: number;
}

export function AuditLogFilters({ value, onChange, requesters, resultCount }: Props) {
  const [draft, setDraft] = useState<AuditLogFiltersState>(value);

  // Keep the local draft in sync if the parent resets filters from elsewhere.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  function update<K extends keyof AuditLogFiltersState>(
    key: K,
    next: AuditLogFiltersState[K],
  ) {
    const merged = { ...draft, [key]: next };
    setDraft(merged);
    onChange(merged);
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(EMPTY_FILTERS);

  return (
    <div className="sticky top-0 z-20 -mx-4 mb-4 border-b border-[color:var(--color-border)] bg-[color:var(--color-surface)]/95 px-4 py-3 backdrop-blur">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From">
          <input
            type="datetime-local"
            value={draft.from}
            onChange={(e) => update("from", e.target.value)}
            className="input"
          />
        </Field>
        <Field label="To">
          <input
            type="datetime-local"
            value={draft.to}
            onChange={(e) => update("to", e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Action">
          <select
            value={draft.action}
            onChange={(e) => update("action", e.target.value)}
            className="input min-w-[180px]"
          >
            <option value="">All actions</option>
            {ACTION_CODES.map((code) => (
              <option key={code} value={code}>
                {ACTION_LABELS[code] ?? code}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Requested by">
          <select
            value={draft.requestedBy}
            onChange={(e) => update("requestedBy", e.target.value)}
            className="input min-w-[180px]"
          >
            <option value="">Anyone</option>
            {requesters.map((u) =>
              u.id ? (
                <option key={u.id} value={u.id}>
                  {u.name ?? u.id}
                  {u.role ? ` · ${u.role.replace(/_/g, " ")}` : ""}
                </option>
              ) : null,
            )}
          </select>
        </Field>
        <Field label="Entity">
          <input
            type="text"
            value={draft.entityId}
            onChange={(e) => update("entityId", e.target.value)}
            placeholder="Loan ID / IMEI / Lead ID"
            className="input min-w-[200px]"
          />
        </Field>
        {dirty ? (
          <button
            type="button"
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              onChange(EMPTY_FILTERS);
            }}
            className="text-xs font-semibold text-[color:var(--color-brand-sky)] hover:underline"
          >
            Reset filters
          </button>
        ) : null}
        <div className="ml-auto text-xs font-medium tabular-nums text-[color:var(--color-ink-muted)]">
          {resultCount.toLocaleString("en-IN")} events
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {STATUS_FILTERS.map((s) => {
          const active = draft.status === s.value;
          return (
            <button
              key={s.value || "all"}
              type="button"
              onClick={() => update("status", s.value)}
              className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                active
                  ? "bg-[color:var(--color-brand-navy)] text-white"
                  : "border border-[color:var(--color-border)] bg-[color:var(--color-bg)] text-[color:var(--color-ink-muted)] hover:bg-slate-100"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      <style jsx>{`
        .input {
          border-radius: 6px;
          border: 1px solid var(--color-border);
          background: var(--color-surface);
          padding: 0.375rem 0.5rem;
          font-size: 0.8125rem;
          color: var(--color-ink);
        }
        .input:focus {
          outline: 2px solid var(--color-brand-sky);
          outline-offset: -1px;
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

export default AuditLogFilters;
