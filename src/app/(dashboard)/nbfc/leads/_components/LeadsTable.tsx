"use client";

/**
 * LeadsTable — Lead Intelligence list + read-only detail drawer (BRD §6.1.4).
 *
 * Renders the leads list through the responsive table primitive (desktop
 * table / mobile card-stack) and opens a read-only lead detail drawer when a
 * row is tapped — the BRD-mandated "clickable, opens lead detail modal".
 * NBFC users cannot modify leads, so the drawer is purely informational; the
 * CDS/PCI badges inside it stay interactive (explainability).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import ResponsiveTable, {
  type ResponsiveColumn,
} from "@/components/nbfc-portal/ResponsiveTable";
import ScoreBadge from "@/components/nbfc-portal/ScoreBadge";
import { SendPaymentReminderButton } from "@/components/nbfc-portal/SendPaymentReminderButton";
import { FlagForRecoveryDialog } from "@/components/nbfc-portal/FlagForRecoveryDialog";
import { UnflagRecoveryDialog } from "@/components/nbfc-portal/UnflagRecoveryDialog";
import LeadAuditTimeline from "@/components/nbfc-portal/audit-log/LeadAuditTimeline";

export type LeadRow = {
  loan_application_id: string;
  sanction_id: string | null;
  lead_id: string | null;
  reference_id: string | null;
  full_name: string | null;
  dealer_name: string | null;
  battery_serial: string | null;
  loan_amount: number | null;
  loan_file_number: string | null;
  status: string;
  recovery_flagged: boolean;
  recovery_flagged_at: string | null;
  current_dpd: number | null;
  outstanding_amount: number | null;
  overdue_days: number | null;
  next_emi_date: string | null;
  created_at: string | null;
  cds_score: number | null;
  cds_band: "low" | "mid" | "high" | "na";
  city: string | null;
  state: string | null;
  product_model: string | null;
};

type Bands = { low_mid: number; mid_high: number };

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-IN");
}

function statusTone(status: string): string {
  const s = status.toLowerCase();
  if (s === "overdue") return "status-pill-danger";
  if (s === "closed" || s === "foreclosed") return "status-pill-neutral";
  if (s === "disbursed" || s === "active") return "status-pill-success";
  return "status-pill-info";
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`status-pill ${statusTone(status)} capitalize`}>
      {status || "—"}
    </span>
  );
}

/**
 * Distinct badge for loans already flagged for recovery (loan_sanctions.
 * recovery_flagged_at is set). Kept separate from the lifecycle status pill —
 * a flagged loan still carries its own status (overdue / disbursed) — and given
 * a purple tone so it reads as an escalation, not a normal stage.
 */
function RecoveryBadge() {
  return (
    <span
      className="status-pill"
      title="This loan has been flagged for recovery"
      style={{
        background: "#f5f3ff",
        color: "#6d28d9",
        border: "1px solid #ddd6fe",
      }}
    >
      <span aria-hidden="true">⚑</span> Flagged for Recovery
    </span>
  );
}

/** Status cell: lifecycle status + a recovery escalation badge when flagged. */
function StatusCell({ row }: { row: LeadRow }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <StatusPill status={row.status} />
      {row.recovery_flagged ? <RecoveryBadge /> : null}
    </div>
  );
}

function EmiStatus({ row }: { row: LeadRow }) {
  if (row.overdue_days != null && row.overdue_days > 0) {
    return (
      <span className="font-semibold text-[color:var(--color-danger)]">
        {row.overdue_days}d overdue
      </span>
    );
  }
  if (row.next_emi_date) {
    return (
      <span className="text-[color:var(--color-ink-muted)]">
        Next {fmtDate(row.next_emi_date)}
      </span>
    );
  }
  return <span className="text-[color:var(--color-ink-muted)]">—</span>;
}

/** Read-only lead detail drawer — BRD §6.1.4. */
function LeadDetailDrawer({
  row,
  bands,
  onClose,
  onFlagChange,
}: {
  row: LeadRow;
  bands: Bands;
  onClose: () => void;
  /** Lifts the flag state so the list badge updates without a page reload. */
  onFlagChange: (next: {
    recovery_flagged: boolean;
    recovery_flagged_at: string | null;
  }) => void;
}) {
  const [flagOpen, setFlagOpen] = useState(false);
  const [unflagOpen, setUnflagOpen] = useState(false);

  useEffect(() => {
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
  }, [onClose]);

  const thresholds = { cdsWarning: bands.low_mid, cdsHigh: bands.mid_high };

  return (
    <>
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Lead detail"
      onClick={onClose}
    >
      <aside
        className="h-full w-full max-w-md overflow-y-auto bg-[color:var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 flex items-start justify-between gap-3 border-b border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-5 py-4">
          <div className="min-w-0">
            <p className="section-label-muted">Lead Detail</p>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-[color:var(--color-brand-navy)]">
              {row.full_name ?? "Unnamed borrower"}
            </h2>
            <p className="font-mono text-xs text-[color:var(--color-brand-sky)]">
              {row.reference_id ?? row.loan_application_id}
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
            <StatusPill status={row.status} />
            {row.recovery_flagged ? <RecoveryBadge /> : null}
            <span className="text-xs text-[color:var(--color-ink-muted)]">
              Read-only — NBFC partners cannot modify leads.
            </span>
          </div>

          <DetailSection title="Loan">
            <Field label="Loan Amount" value={row.loan_amount != null ? inr(row.loan_amount) : "—"} />
            <Field label="Loan File No." value={row.loan_file_number ?? "—"} mono />
            <Field label="Product" value={row.product_model ?? "—"} />
            <Field label="Sanctioned" value={fmtDate(row.created_at)} />
          </DetailSection>

          <DetailSection title="Risk">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-ink-muted)]">
                CDS Score
              </span>
              <ScoreBadge
                type="cds"
                value={row.cds_score}
                loanSanctionId={row.sanction_id}
                thresholds={thresholds}
              />
            </div>
            <p className="text-xs text-[color:var(--color-ink-muted)]">
              Tap the score for the full explainability breakdown.
            </p>
          </DetailSection>

          <DetailSection title="Servicing">
            <Field
              label="Outstanding"
              value={row.outstanding_amount != null ? inr(row.outstanding_amount) : "—"}
            />
            <Field
              label="Current DPD"
              value={row.current_dpd != null ? `${row.current_dpd} days` : "—"}
            />
            <Field
              label="EMI Status"
              value={
                row.overdue_days != null && row.overdue_days > 0
                  ? `${row.overdue_days} days overdue`
                  : row.next_emi_date
                    ? `Next due ${fmtDate(row.next_emi_date)}`
                    : "—"
              }
            />
          </DetailSection>

          <DetailSection title="Asset">
            {row.battery_serial ? (
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-ink-muted)]">
                  Battery Serial
                </span>
                <Link
                  href={`/nbfc/batteries?q=${encodeURIComponent(row.battery_serial)}`}
                  className="font-mono text-xs font-semibold text-[color:var(--color-brand-sky)] hover:underline"
                >
                  {row.battery_serial}
                </Link>
              </div>
            ) : (
              <Field label="Battery Serial" value="—" />
            )}
          </DetailSection>

          <DetailSection title="Origination">
            <Field label="Dealer" value={row.dealer_name ?? "—"} />
            <Field
              label="Geography"
              value={[row.city, row.state].filter(Boolean).join(", ") || "—"}
            />
          </DetailSection>

          {row.sanction_id ? (
            <section>
              <h3 className="section-label mb-2">Risk Actions</h3>
              <div className="space-y-3 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3">
                <div>
                  <p className="mb-1.5 text-xs font-semibold text-[color:var(--color-ink-muted)]">
                    Payment reminder
                    <span className="font-normal"> · single approval (§6.1.6)</span>
                  </p>
                  <SendPaymentReminderButton
                    loanSanctionId={row.sanction_id}
                    context={{
                      entity_type: "lead",
                      lead_id: row.lead_id ?? row.loan_application_id,
                    }}
                  />
                </div>
                <div className="border-t border-[color:var(--color-border)] pt-3">
                  <p className="mb-1.5 text-xs font-semibold text-[color:var(--color-ink-muted)]">
                    Flag for recovery
                    <span className="font-normal">
                      {" "}
                      · Risk Head, reversible until recovery starts
                    </span>
                  </p>
                  {row.recovery_flagged ? (
                    <div
                      className="rounded-lg border px-3 py-2 text-xs"
                      style={{
                        background: "#f5f3ff",
                        borderColor: "#ddd6fe",
                        color: "#6d28d9",
                      }}
                    >
                      <span className="font-semibold">
                        ⚑ Already flagged for recovery
                      </span>
                      {row.recovery_flagged_at ? (
                        <span className="block text-[color:var(--color-ink-muted)]">
                          Flagged on {fmtDate(row.recovery_flagged_at)} · track it
                          in the Recovery &amp; Auction queue.
                        </span>
                      ) : (
                        <span className="block text-[color:var(--color-ink-muted)]">
                          Track it in the Recovery &amp; Auction queue.
                        </span>
                      )}
                      {/* Flagged the wrong loan? The escape hatch lives next to
                          the flag it undoes, not in a separate admin screen. */}
                      <button
                        type="button"
                        onClick={() => setUnflagOpen(true)}
                        className="mt-2 rounded-md border px-2.5 py-1 text-[11px] font-semibold"
                        style={{
                          borderColor: "#c4b5fd",
                          background: "#fff",
                          color: "#5b21b6",
                        }}
                      >
                        Withdraw flag
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setFlagOpen(true)}
                      className="btn-danger text-sm"
                    >
                      Flag for Recovery
                    </button>
                  )}
                </div>
              </div>
            </section>
          ) : null}

          {row.sanction_id ? (
            <section>
              <h3 className="section-label mb-2">Audit Timeline</h3>
              <div className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3">
                <LeadAuditTimeline entityId={row.sanction_id} />
              </div>
            </section>
          ) : null}
        </div>
      </aside>
    </div>
      {row.sanction_id ? (
        <>
          <FlagForRecoveryDialog
            loanSanctionId={row.sanction_id}
            open={flagOpen}
            onClose={() => setFlagOpen(false)}
            batterySerial={row.battery_serial}
            context={{
              entity_type: "lead",
              lead_id: row.lead_id ?? row.loan_application_id,
            }}
            onFlagged={(result) =>
              onFlagChange({
                recovery_flagged: true,
                recovery_flagged_at: result.flagged_at,
              })
            }
          />
          <UnflagRecoveryDialog
            loanSanctionId={row.sanction_id}
            open={unflagOpen}
            onClose={() => setUnflagOpen(false)}
            batterySerial={row.battery_serial}
            context={{
              entity_type: "lead",
              lead_id: row.lead_id ?? row.loan_application_id,
            }}
            onUnflagged={() =>
              onFlagChange({
                recovery_flagged: false,
                recovery_flagged_at: null,
              })
            }
          />
        </>
      ) : null}
    </>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="section-label mb-2">{title}</h3>
      <div className="space-y-2 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3">
        {children}
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-ink-muted)]">
        {label}
      </span>
      <span
        className={`text-sm text-[color:var(--color-ink)] text-right ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

export default function LeadsTable({
  rows,
  bands,
}: {
  rows: LeadRow[];
  bands: Bands;
}) {
  const [selected, setSelected] = useState<LeadRow | null>(null);
  const router = useRouter();
  const thresholds = { cdsWarning: bands.low_mid, cdsHigh: bands.mid_high };

  // `rows` is server-rendered, so flagging or withdrawing a flag would leave a
  // stale badge until the next navigation. These overrides paint the new state
  // immediately; router.refresh() then re-fetches the authoritative rows.
  type FlagState = {
    recovery_flagged: boolean;
    recovery_flagged_at: string | null;
  };
  const [flagOverrides, setFlagOverrides] = useState<Record<string, FlagState>>(
    {},
  );
  const withOverride = (r: LeadRow): LeadRow => {
    const o = flagOverrides[r.loan_application_id];
    return o ? { ...r, ...o } : r;
  };
  const displayRows = rows.map(withOverride);
  const selectedRow = selected ? withOverride(selected) : null;

  const columns: ResponsiveColumn<LeadRow>[] = [
    {
      key: "customer",
      header: "Customer",
      mobile: "primary",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-semibold text-[color:var(--color-ink)]">
            {r.full_name ?? "—"}
          </div>
          <div className="truncate font-mono text-[11px] text-[color:var(--color-brand-sky)]">
            {r.reference_id ?? r.loan_application_id}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      mobile: "primary",
      align: "right",
      render: (r) => <StatusCell row={r} />,
    },
    {
      key: "dealer",
      header: "Dealer",
      mobile: "hidden",
      render: (r) => (
        <span className="text-xs">{r.dealer_name ?? "—"}</span>
      ),
    },
    {
      key: "battery",
      header: "Battery Serial",
      render: (r) =>
        r.battery_serial ? (
          <span className="font-mono text-xs">{r.battery_serial}</span>
        ) : (
          <span className="text-[color:var(--color-ink-muted)]">—</span>
        ),
    },
    {
      key: "amount",
      header: "Loan Amount",
      align: "right",
      render: (r) => (
        <span className="tabular-nums">
          {r.loan_amount != null ? inr(r.loan_amount) : "—"}
        </span>
      ),
    },
    {
      key: "fileno",
      header: "Loan File No.",
      mobile: "hidden",
      render: (r) => (
        <span className="font-mono text-xs">{r.loan_file_number ?? "—"}</span>
      ),
    },
    {
      key: "product",
      header: "Product",
      mobile: "hidden",
      render: (r) => (
        <span className="text-xs">{r.product_model ?? "—"}</span>
      ),
    },
    {
      key: "cds",
      header: "CDS Score",
      render: (r) => (
        <ScoreBadge
          type="cds"
          value={r.cds_score}
          loanSanctionId={r.sanction_id}
          thresholds={thresholds}
        />
      ),
    },
    {
      key: "emi",
      header: "EMI Status",
      render: (r) => <EmiStatus row={r} />,
    },
  ];

  return (
    <>
      <ResponsiveTable
        columns={columns}
        rows={displayRows}
        rowKey={(r) => r.loan_application_id}
        onRowClick={(r) => setSelected(r)}
        emptyMessage="No leads match these filters."
        caption="Leads referred via iTarang"
      />
      {selectedRow ? (
        <LeadDetailDrawer
          row={selectedRow}
          bands={bands}
          onClose={() => setSelected(null)}
          onFlagChange={(next) => {
            setFlagOverrides((prev) => ({
              ...prev,
              [selectedRow.loan_application_id]: next,
            }));
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
