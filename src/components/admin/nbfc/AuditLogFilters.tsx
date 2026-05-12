"use client";

/**
 * E-071 — Filter bar for the Admin Audit Log table (BRD §6.3.5).
 *
 * Renders date range, action, requestedBy, status, entityId inputs and
 * emits a flat object on submit.
 */
import { useState } from "react";

export type AuditLogFilterValue = {
  from?: string;
  to?: string;
  action?: string;
  requestedBy?: string;
  status?: "executed" | "pending" | "rejected";
  entityId?: string;
};

type Props = {
  initial?: AuditLogFilterValue;
  onChange: (next: AuditLogFilterValue) => void;
};

export default function AuditLogFilters({ initial, onChange }: Props) {
  const [val, setVal] = useState<AuditLogFilterValue>(initial ?? {});

  function set<K extends keyof AuditLogFilterValue>(
    k: K,
    v: AuditLogFilterValue[K],
  ) {
    setVal((prev) => ({ ...prev, [k]: v }));
  }

  return (
    <form
      data-testid="audit-log-filters"
      className="flex flex-wrap items-end gap-3 border-b pb-3"
      onSubmit={(e) => {
        e.preventDefault();
        onChange(val);
      }}
    >
      <label className="flex flex-col text-xs">
        From
        <input
          type="datetime-local"
          data-testid="audit-log-filter-from"
          className="rounded border px-2 py-1 text-sm"
          value={val.from ?? ""}
          onChange={(e) => set("from", e.target.value || undefined)}
        />
      </label>
      <label className="flex flex-col text-xs">
        To
        <input
          type="datetime-local"
          data-testid="audit-log-filter-to"
          className="rounded border px-2 py-1 text-sm"
          value={val.to ?? ""}
          onChange={(e) => set("to", e.target.value || undefined)}
        />
      </label>
      <label className="flex flex-col text-xs">
        Action
        <input
          type="text"
          data-testid="audit-log-filter-action"
          className="rounded border px-2 py-1 text-sm"
          placeholder="IMMOBILIZATION_REQUESTED"
          value={val.action ?? ""}
          onChange={(e) => set("action", e.target.value || undefined)}
        />
      </label>
      <label className="flex flex-col text-xs">
        Requested by (user id)
        <input
          type="text"
          data-testid="audit-log-filter-requested-by"
          className="rounded border px-2 py-1 text-sm"
          value={val.requestedBy ?? ""}
          onChange={(e) => set("requestedBy", e.target.value || undefined)}
        />
      </label>
      <label className="flex flex-col text-xs">
        Status
        <select
          data-testid="audit-log-filter-status"
          className="rounded border px-2 py-1 text-sm"
          value={val.status ?? ""}
          onChange={(e) =>
            set(
              "status",
              (e.target.value || undefined) as AuditLogFilterValue["status"],
            )
          }
        >
          <option value="">Any</option>
          <option value="executed">Executed</option>
          <option value="pending">Pending</option>
          <option value="rejected">Rejected</option>
        </select>
      </label>
      <label className="flex flex-col text-xs">
        Entity id
        <input
          type="text"
          data-testid="audit-log-filter-entity"
          className="rounded border px-2 py-1 text-sm"
          value={val.entityId ?? ""}
          onChange={(e) => set("entityId", e.target.value || undefined)}
        />
      </label>
      <button
        type="submit"
        data-testid="audit-log-filter-apply"
        className="rounded bg-black px-3 py-1.5 text-sm text-white"
      >
        Apply
      </button>
    </form>
  );
}
