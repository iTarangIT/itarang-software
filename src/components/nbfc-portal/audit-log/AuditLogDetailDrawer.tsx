"use client";

/**
 * Side drawer for an audit-log row. Shows the full BRD §6.3.5 envelope:
 * actor + approver, reason, before/after JSON diff, borrower-notice link, and
 * deep links into the source entity (loan / battery / lead).
 */
import { useEffect } from "react";
import Link from "next/link";
import { X, ExternalLink } from "lucide-react";
import { entityTone, statusTone, type AuditLogRow } from "./types";

interface Props {
  row: AuditLogRow | null;
  onClose: () => void;
}

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "long",
});

export function AuditLogDetailDrawer({ row, onClose }: Props) {
  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [row, onClose]);

  if (!row) return null;

  const tone = statusTone(row.status);
  const ent = entityTone(row.entity.type);
  const sourceLink = entitySourceLink(row);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Audit log entry detail"
      onClick={onClose}
    >
      <aside
        className="h-full w-full max-w-xl overflow-y-auto bg-[color:var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-5 py-4">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
              Audit log entry
            </p>
            <h2 className="mt-0.5 text-lg font-semibold text-[color:var(--color-brand-navy)]">
              {row.action_label}
            </h2>
            <p className="font-mono text-[11px] text-[color:var(--color-ink-muted)]">
              {row.timestamp ? dateFmt.format(new Date(row.timestamp)) : "—"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-bg)]"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="space-y-5 px-5 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone.bg} ${tone.text}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
              {tone.label}
            </span>
            <span
              className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${ent.bg} ${ent.text}`}
            >
              {ent.label}
            </span>
            <span className="font-mono text-[11px] text-[color:var(--color-ink)]">
              {row.entity.label ?? "—"}
            </span>
            {sourceLink ? (
              <Link
                href={sourceLink}
                className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-[color:var(--color-brand-sky)] hover:underline"
              >
                Open source <ExternalLink className="h-3 w-3" />
              </Link>
            ) : null}
          </div>

          <Section title="Actor">
            <KV label="Requested by" value={row.requested_by.name ?? row.requested_by.id ?? "—"} />
            {row.requested_by.role ? (
              <KV label="Role" value={row.requested_by.role.replace(/_/g, " ")} />
            ) : null}
            {row.approved_by ? (
              <>
                <KV
                  label="Approved by"
                  value={row.approved_by.name ?? row.approved_by.id ?? "—"}
                />
                {row.approved_by.role ? (
                  <KV label="Approver role" value={row.approved_by.role.replace(/_/g, " ")} />
                ) : null}
              </>
            ) : null}
          </Section>

          {row.reason_text || row.reason_code ? (
            <Section title="Reason">
              {row.reason_code ? <KV label="Code" value={row.reason_code} /> : null}
              {row.reason_text ? (
                <p className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3 text-sm leading-relaxed text-[color:var(--color-ink)]">
                  {row.reason_text}
                </p>
              ) : null}
            </Section>
          ) : null}

          {row.borrower_notified_at ? (
            <Section title="Borrower notice">
              <KV
                label="Notified at"
                value={dateFmt.format(new Date(row.borrower_notified_at))}
              />
              <p className="text-xs text-[color:var(--color-ink-muted)]">
                Per RBI Digital Lending Directions 2025 §6.1.6 — the mandatory
                borrower notice was issued before the action took effect.
              </p>
            </Section>
          ) : null}

          {row.before_state || row.after_state ? (
            <Section title="State diff">
              <div className="grid grid-cols-2 gap-3">
                <JsonBox title="Before" value={row.before_state} />
                <JsonBox title="After" value={row.after_state} />
              </div>
            </Section>
          ) : null}

          {row.payload ? (
            <Section title="Payload">
              <JsonBox title="Raw" value={row.payload} />
            </Section>
          ) : null}

          <Section title="Provenance">
            <KV label="Source table" value={prettySource(row.source)} />
            <KV label="Entry id" value={row.id} mono />
          </Section>
        </div>
      </aside>
    </div>
  );
}

function entitySourceLink(row: AuditLogRow): string | null {
  if (!row.entity.id) return null;
  if (row.entity.type === "loan")
    return `/nbfc/batteries?q=${encodeURIComponent(row.entity.id)}`;
  if (row.entity.type === "battery")
    return `/nbfc/batteries?q=${encodeURIComponent(row.entity.id)}`;
  if (row.entity.type === "lead")
    return `/nbfc/leads?q=${encodeURIComponent(row.entity.id)}`;
  return null;
}

function prettySource(s: AuditLogRow["source"]): string {
  if (s === "audit_log") return "nbfc_audit_log (immutable)";
  if (s === "borrower_action") return "nbfc_borrower_actions";
  return "nbfc_immobilisation_actions";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-ink-muted)]">
        {label}
      </span>
      <span
        className={`text-right text-sm text-[color:var(--color-ink)] ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function JsonBox({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
      <div className="border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-[color:var(--color-ink-muted)]">
        {title}
      </div>
      <pre className="max-h-64 overflow-auto bg-[color:var(--color-surface)] p-2 font-mono text-[11px] leading-snug text-[color:var(--color-ink)]">
        {value == null ? "—" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default AuditLogDetailDrawer;
