"use client";

/**
 * The flagged-recovery book, row-wise.
 *
 * One row per flagged loan; the expanded panel carries everything the flag
 * dialog and the joins behind it know — the typed reason, the loan, the dealer
 * record and the battery master stub. Filtering is client-side because the
 * whole flagged book is small by construction: a flag is a decision somebody
 * made one at a time, not a feed.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AgentActionPanel from "./AgentActionPanel";
import { formatINR } from "@/components/auction/AuctionPrimitives";

export interface RecoveryRow {
  sanction_id: string;
  lead_id: string | null;
  reference_id: string | null;
  loan_file_number: string | null;
  loan_amount: number | null;
  sanction_status: string | null;
  sanctioned_at: string | null;
  flagged_at: string | null;
  reason: string | null;

  borrower_name: string | null;
  borrower_phone: string | null;
  city: string | null;
  state: string | null;

  dealer_code: string | null;
  dealer_name: string | null;
  dealer_owner: string | null;
  dealer_phone: string | null;
  dealer_email: string | null;
  dealer_gst: string | null;
  dealer_address: string | null;

  product_model: string | null;
  outstanding: number | null;
  dpd: number | null;
  next_emi_date: string | null;

  battery_serial: string | null;
  battery_id: string | null;
  battery_model: string | null;
  battery_capacity: string | null;
  battery_condition: string | null;
  battery_state: string | null;
  battery_warehouse: string | null;
  battery_city: string | null;
  battery_state_name: string | null;
  battery_photos: number;
  recovery_date: string | null;

  pipeline_id: string | null;
  stage: string | null;
  estimated_recovery_value: number | null;
  stage_updated_at: string | null;

  /** The live dispatch, or null when nobody has been sent yet. */
  assignment: AssignmentRow | null;
}

export interface AssignmentRow {
  id: string;
  status: string;
  attempt_no: number;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  assigned_at: string | null;
  due_at: string | null;
  link_sent_at: string | null;
  link_channel: string | null;
  link_expires_at: string | null;
  dispatch_error: string | null;
  collected_at: string | null;
  condition_notes: string | null;
  distance_from_address_m: number | null;
  gps_accuracy_m: number | null;
  gps_lat: number | null;
  gps_lng: number | null;
  has_address_anchor: boolean;
  cancel_reason: string | null;
  cancel_source: string | null;
  cancelled_at: string | null;
  review_decision: string | null;
  review_notes: string | null;
  reviewed_at: string | null;
  /** Decided server-side against the server clock. See the note in page.tsx. */
  link_expired: boolean;
  /** Only populated once there is something to review. */
  photos: AssignmentPhoto[];
  auto_flags: AutoFlag[];
  /** [E-263] The journeys that produced nothing, and the promised return. */
  next_visit_at: string | null;
  visit_attempt_count: number;
  visits: VisitAttempt[];
}

export interface VisitAttempt {
  attempt_no: number;
  outcome: string;
  notes: string | null;
  next_visit_at: string | null;
  created_at: string;
  distance_from_address_m: number | null;
  gps_lat: number | null;
  gps_lng: number | null;
}

export interface AssignmentPhoto {
  id: string;
  photo_type: string;
  image_url: string;
  watermark_applied: boolean;
}

export interface AutoFlag {
  key: string;
  severity: "red" | "warn";
  label: string;
}

export interface AgentOption {
  id: string;
  name: string;
  city: string | null;
  coverage_area: string | null;
  contact: string | null;
  preferred_channel: string;
}

export interface RecoveryPermissions {
  assign: boolean;
  review: boolean;
  cancel: boolean;
}

/**
 * What the coordinator sees for each state of a dispatch. `assigned` and
 * `in_progress` deliberately read differently: the first means the link exists
 * but nothing confirmed it was delivered, and burying that would leave somebody
 * waiting on an agent who never heard from us.
 */
const ASSIGNMENT_TONE: Record<string, string> = {
  assigned: "warn",
  in_progress: "",
  collected: "live",
  completed: "muted",
  rejected: "warn",
  cancelled: "muted",
};

/** [E-263] The agent's own words for a journey that produced nothing. */
export const VISIT_OUTCOME_LABELS: Record<string, string> = {
  not_present: "Customer not present",
  refused: "Customer refused to hand it over",
  address_not_found: "Could not find the address",
  battery_missing: "Battery not at the address",
  other: "Other",
};

/** The four slots the field form asks for, plus whatever else they shot. */
export const PHOTO_LABELS: Record<string, string> = {
  serial: "Serial plate",
  battery: "Battery as found",
  vehicle: "Vehicle",
  agent_selfie: "Agent",
  extra: "Extra",
};

const ASSIGNMENT_LABEL: Record<string, string> = {
  assigned: "link not confirmed",
  in_progress: "agent notified",
  collected: "awaiting review",
  completed: "collected",
  rejected: "rejected",
  cancelled: "cancelled",
};

const STAGES: Array<{ id: string; label: string }> = [
  { id: "all", label: "All" },
  { id: "needs_inspection", label: "Needs inspection" },
  { id: "refurbishable", label: "Refurbishable" },
  { id: "ready_for_auction", label: "Ready for auction" },
  { id: "scrap", label: "Scrap" },
  { id: "resold", label: "Resold" },
];

/**
 * The dispatch dimension, as something you can filter on.
 *
 * The Agent column was the one column on this table with no way to narrow by
 * it, which is backwards: "who have we sent nobody to" and "what is sitting on
 * my desk waiting to be approved" are the two questions this page exists to
 * answer, and both are about dispatch, not pipeline stage.
 *
 * `needs_return` is not a status — it is derived from `next_visit_at` being
 * set. An agent who attended, found nobody and promised to go back is neither
 * "notified" nor "awaiting review", and lumping them in with either loses the
 * only rows where somebody has to turn up on a particular day.
 */
const DISPATCH_FILTERS: Array<{ id: string; label: string }> = [
  { id: "any", label: "Any dispatch state" },
  { id: "none", label: "Not dispatched" },
  { id: "assigned", label: "Link not confirmed" },
  { id: "in_progress", label: "Agent notified" },
  { id: "needs_return", label: "Return visit promised" },
  { id: "collected", label: "Awaiting my review" },
  { id: "completed", label: "Collected & approved" },
  { id: "cancelled", label: "Cancelled / rejected" },
];

function matchesDispatch(r: RecoveryRow, id: string): boolean {
  if (id === "any") return true;
  const a = r.assignment;
  if (id === "none") return !a || a.status === "cancelled" || a.status === "rejected";
  if (!a) return false;
  if (id === "needs_return") {
    return a.next_visit_at != null && (a.status === "assigned" || a.status === "in_progress");
  }
  if (id === "cancelled") return a.status === "cancelled" || a.status === "rejected";
  return a.status === id;
}

/** DPD severity buckets, matching the ones Lead Intelligence already uses. */
const DPD_FILTERS: Array<{ id: string; label: string; test: (d: number) => boolean }> = [
  { id: "any", label: "Any DPD", test: () => true },
  { id: "0", label: "Current (0 days)", test: (d) => d <= 0 },
  { id: "1-30", label: "1–30 days", test: (d) => d >= 1 && d <= 30 },
  { id: "31-60", label: "31–60 days", test: (d) => d >= 31 && d <= 60 },
  { id: "60+", label: "60+ days", test: (d) => d > 60 },
];

/** Stage colour, borrowed from the lot-status vocabulary so the two agree. */
function stageTone(stage: string | null): string {
  switch (stage) {
    case "ready_for_auction":
      return "live";
    case "scrap":
      return "warn";
    case "resold":
      return "muted";
    default:
      return "";
  }
}

const dash = "—";

function date(iso: string | null): string {
  if (!iso) return dash;
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function dateTime(iso: string | null): string {
  if (!iso) return dash;
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function money(v: number | null): string {
  return v == null ? dash : formatINR(v);
}

/**
 * A label/value pair inside an expanded row. `.auc-dl` is a fixed two-column
 * grid; these panels carry eight or nine fields, so the column count is
 * relaxed on the <dl> below rather than forking the stylesheet.
 */
const FIELDS_STYLE: React.CSSProperties = {
  gridTemplateColumns: "repeat(auto-fill, minmax(11rem, 1fr))",
};

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode | null;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value == null || value === "" ? (
          <span className="auc-subtle">{dash}</span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

export default function RecoveryQueueTable({
  rows,
  agents,
  can,
}: {
  rows: RecoveryRow[];
  agents: AgentOption[];
  can: RecoveryPermissions;
}) {
  const router = useRouter();
  const [stage, setStage] = useState("all");
  const [q, setQ] = useState("");
  const [dispatch, setDispatch] = useState("any");
  const [dealer, setDealer] = useState("");
  const [place, setPlace] = useState("");
  const [dpd, setDpd] = useState("any");
  const [openId, setOpenId] = useState<string | null>(null);
  /** Which row has its Action panel open. Independent of the Details panel. */
  const [actionId, setActionId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const key = r.stage ?? "needs_inspection";
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    m.set("all", rows.length);
    return m;
  }, [rows]);

  /** The options are derived from the rows, so a filter can never offer a
   *  dealer or a city that would return nothing. */
  const dealerOptions = useMemo(
    () =>
      Array.from(
        new Set(rows.map((r) => r.dealer_name).filter((v): v is string => !!v)),
      ).sort(),
    [rows],
  );
  const placeOptions = useMemo(
    () =>
      Array.from(
        new Set(
          rows
            .map((r) => [r.city, r.state].filter(Boolean).join(", "))
            .filter((v) => v !== ""),
        ),
      ).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const dpdRule = DPD_FILTERS.find((d) => d.id === dpd) ?? DPD_FILTERS[0];
    return rows.filter((r) => {
      if (stage !== "all" && (r.stage ?? "needs_inspection") !== stage) return false;
      if (!matchesDispatch(r, dispatch)) return false;
      if (dealer && r.dealer_name !== dealer) return false;
      if (place && [r.city, r.state].filter(Boolean).join(", ") !== place) return false;
      // A null DPD is treated as 0 — current, not delinquent — which is the
      // same reading Lead Intelligence takes.
      if (!dpdRule.test(r.dpd ?? 0)) return false;
      if (!needle) return true;
      return [
        r.borrower_name,
        r.reference_id,
        r.sanction_id,
        r.loan_file_number,
        r.battery_serial,
        r.dealer_name,
        r.dealer_code,
        r.city,
        r.state,
        // The agent is on the row, so it should be searchable from the row.
        r.assignment?.agent_name,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [rows, stage, q, dispatch, dealer, place, dpd]);

  const filtersActive =
    dispatch !== "any" || dealer !== "" || place !== "" || dpd !== "any" || q.trim() !== "";

  function clearFilters() {
    setDispatch("any");
    setDealer("");
    setPlace("");
    setDpd("any");
    setQ("");
  }

  const outstandingTotal = filtered.reduce(
    (sum, r) => sum + (r.outstanding ?? 0),
    0,
  );

  return (
    <div>
      <div className="auc-kpis">
        <div className="auc-kpi">
          <span className="auc-label">Flagged for recovery</span>
          <b className="auc-num">{rows.length}</b>
        </div>
        <div className="auc-kpi">
          <span className="auc-label">Awaiting inspection</span>
          <b className="auc-num">{counts.get("needs_inspection") ?? 0}</b>
        </div>
        <div className="auc-kpi">
          <span className="auc-label">
            Outstanding{stage === "all" && !filtersActive ? "" : " (filtered)"}
          </span>
          <b className="auc-num">{money(outstandingTotal)}</b>
        </div>
      </div>

      <div className="auc-tabs" role="tablist" aria-label="Recovery stage">
        {STAGES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            className="auc-tab"
            aria-selected={stage === s.id}
            onClick={() => {
              setStage(s.id);
              setOpenId(null);
            }}
          >
            {s.label}
            <span className="auc-tab-n">{counts.get(s.id) ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="auc-toolbar">
        <input
          className="auc-input"
          style={{ flex: "2 1 18rem" }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Borrower, battery serial, dealer, agent, loan number or city"
          aria-label="Search the recovery book"
        />
        <select
          className="auc-input"
          style={{ flex: "1 1 11rem" }}
          value={dispatch}
          onChange={(e) => setDispatch(e.target.value)}
          aria-label="Filter by dispatch state"
        >
          {DISPATCH_FILTERS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <select
          className="auc-input"
          style={{ flex: "1 1 9rem" }}
          value={dpd}
          onChange={(e) => setDpd(e.target.value)}
          aria-label="Filter by days past due"
        >
          {DPD_FILTERS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        {dealerOptions.length > 1 ? (
          <select
            className="auc-input"
            style={{ flex: "1 1 10rem" }}
            value={dealer}
            onChange={(e) => setDealer(e.target.value)}
            aria-label="Filter by dealer"
          >
            <option value="">Any dealer</option>
            {dealerOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        ) : null}
        {placeOptions.length > 1 ? (
          <select
            className="auc-input"
            style={{ flex: "1 1 10rem" }}
            value={place}
            onChange={(e) => setPlace(e.target.value)}
            aria-label="Filter by location"
          >
            <option value="">Anywhere</option>
            {placeOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : null}
        {filtersActive ? (
          <button
            type="button"
            className="auc-btn"
            data-variant="ghost"
            onClick={clearFilters}
          >
            Clear
          </button>
        ) : null}
      </div>

      {filtersActive ? (
        <p className="auc-note" style={{ marginBlockEnd: "0.75rem" }}>
          Showing {filtered.length} of {rows.length}.
        </p>
      ) : null}

      {filtered.length === 0 ? (
        <div className="auc-empty">
          <p>
            {rows.length === 0
              ? "Nothing flagged for recovery"
              : "No rows match this filter"}
          </p>
          <p className="auc-empty-hint">
            {rows.length === 0
              ? "A battery arrives here the moment somebody presses Flag for Recovery on a loan — from the lead drawer on Lead Intelligence, or from the battery case workspace."
              : "Nothing matches these filters. Clear them, or pick another stage."}
          </p>
        </div>
      ) : (
        <div className="auc-scroll-x">
          <table className="auc-table">
            <thead>
              <tr>
                <th>Borrower</th>
                <th>Loan</th>
                <th>Battery</th>
                <th>Dealer</th>
                <th>Geography</th>
                <th className="auc-num">Outstanding</th>
                <th className="auc-num">DPD</th>
                <th>Flagged</th>
                <th>Stage</th>
                <th>Agent</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const open = openId === r.sanction_id;
                return (
                  <RecoveryTableRow
                    key={r.sanction_id}
                    row={r}
                    open={open}
                    onToggle={() => setOpenId(open ? null : r.sanction_id)}
                    actionOpen={actionId === r.sanction_id}
                    onToggleAction={() =>
                      setActionId(
                        actionId === r.sanction_id ? null : r.sanction_id,
                      )
                    }
                    agents={agents}
                    can={can}
                    onChanged={() => router.refresh()}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RecoveryTableRow({
  row: r,
  open,
  onToggle,
  actionOpen,
  onToggleAction,
  agents,
  can,
  onChanged,
}: {
  row: RecoveryRow;
  open: boolean;
  onToggle: () => void;
  actionOpen: boolean;
  onToggleAction: () => void;
  agents: AgentOption[];
  can: RecoveryPermissions;
  onChanged: () => void;
}) {
  const a = r.assignment;
  return (
    <>
      <tr>
        <td>
          <div style={{ fontWeight: 600 }}>{r.borrower_name ?? dash}</div>
          <div className="auc-subtle auc-lotcode">
            {r.reference_id ?? r.lead_id ?? dash}
          </div>
        </td>
        <td>
          <div className="auc-lotcode">{r.sanction_id}</div>
          {r.loan_file_number ? (
            <div className="auc-subtle">{r.loan_file_number}</div>
          ) : null}
        </td>
        <td>
          <div className="auc-lotcode">{r.battery_serial ?? dash}</div>
          {r.battery_condition ? (
            <span className="auc-chip" data-condition={r.battery_condition}>
              {r.battery_condition.replace("_", " ")}
            </span>
          ) : null}
        </td>
        <td>
          <div>{r.dealer_name ?? dash}</div>
          <div className="auc-subtle">
            {[r.dealer_code, r.dealer_phone].filter(Boolean).join(" · ") || dash}
          </div>
        </td>
        <td>{[r.city, r.state].filter(Boolean).join(", ") || dash}</td>
        <td className="auc-num">{money(r.outstanding)}</td>
        <td className="auc-num">
          {r.dpd == null ? (
            dash
          ) : r.dpd > 0 ? (
            <span className="auc-chip" data-tone="warn">
              {r.dpd}d
            </span>
          ) : (
            "0"
          )}
        </td>
        <td>{date(r.flagged_at)}</td>
        <td>
          <span className="auc-chip" data-tone={stageTone(r.stage)}>
            {(r.stage ?? "needs_inspection").replace(/_/g, " ")}
          </span>
        </td>
        <td>
          {a ? (
            <>
              <div>{a.agent_name ?? dash}</div>
              <span className="auc-chip" data-tone={ASSIGNMENT_TONE[a.status] ?? ""}>
                {ASSIGNMENT_LABEL[a.status] ?? a.status.replace(/_/g, " ")}
              </span>
              {a.visit_attempt_count > 0 ? (
                <div className="auc-subtle" style={{ fontSize: "0.6875rem" }}>
                  {a.visit_attempt_count} visit
                  {a.visit_attempt_count === 1 ? "" : "s"}, no battery
                </div>
              ) : null}
            </>
          ) : (
            <span className="auc-subtle">not dispatched</span>
          )}
        </td>
        <td>
          <div style={{ display: "flex", gap: "0.375rem" }}>
            <button
              type="button"
              className="auc-btn"
              aria-expanded={actionOpen}
              onClick={onToggleAction}
            >
              {actionOpen ? "Close" : "Action"}
            </button>
            <button
              type="button"
              className="auc-btn"
              data-variant="ghost"
              aria-expanded={open}
              onClick={onToggle}
            >
              {open ? "Close" : "Details"}
            </button>
          </div>
        </td>
      </tr>
      {actionOpen ? (
        <tr>
          <td colSpan={11} style={{ padding: 0 }}>
            <AgentActionPanel
              row={r}
              agents={agents}
              can={can}
              onChanged={onChanged}
            />
          </td>
        </tr>
      ) : null}
      {open ? (
        <tr>
          <td colSpan={11} style={{ padding: 0 }}>
            <div className="auc-actions">
              {/* The reason is the whole point of the flag dialog's 20-character
                  minimum, and until now it was written to a column nothing
                  read back. */}
              <div>
                <div className="auc-label">Reason recorded at flagging</div>
                <p
                  style={{
                    marginBlockStart: "0.25rem",
                    fontSize: "0.875rem",
                    lineHeight: 1.6,
                    textWrap: "pretty",
                  }}
                >
                  {r.reason?.trim() ? (
                    r.reason
                  ) : (
                    <span className="auc-subtle">
                      No reason stored on this loan.
                    </span>
                  )}
                </p>
              </div>

              <div>
                <div className="auc-label" style={{ marginBlockEnd: "0.5rem" }}>
                  Loan
                </div>
                <dl className="auc-dl" style={FIELDS_STYLE}>
                  <Field label="Sanctioned amount" value={money(r.loan_amount)} />
                  <Field label="Outstanding" value={money(r.outstanding)} />
                  <Field label="Status" value={r.sanction_status} />
                  <Field label="Sanctioned on" value={date(r.sanctioned_at)} />
                  <Field
                    label="Next EMI"
                    value={r.next_emi_date ? date(r.next_emi_date) : null}
                  />
                  <Field label="Product" value={r.product_model} />
                  <Field label="Borrower phone" value={r.borrower_phone} />
                  <Field label="Flagged on" value={dateTime(r.flagged_at)} />
                </dl>
              </div>

              <div>
                <div className="auc-label" style={{ marginBlockEnd: "0.5rem" }}>
                  Dealer
                </div>
                <dl className="auc-dl" style={FIELDS_STYLE}>
                  <Field label="Company" value={r.dealer_name} />
                  <Field label="Dealer code" value={r.dealer_code} />
                  <Field label="Owner" value={r.dealer_owner} />
                  <Field
                    label="Phone"
                    value={
                      r.dealer_phone ? (
                        <a href={`tel:${r.dealer_phone}`}>{r.dealer_phone}</a>
                      ) : null
                    }
                  />
                  <Field
                    label="Email"
                    value={
                      r.dealer_email ? (
                        <a href={`mailto:${r.dealer_email}`}>{r.dealer_email}</a>
                      ) : null
                    }
                  />
                  <Field label="GST" value={r.dealer_gst} />
                  <Field label="Registered address" value={r.dealer_address} />
                </dl>
              </div>

              <div>
                <div className="auc-label" style={{ marginBlockEnd: "0.5rem" }}>
                  Battery
                </div>
                <dl className="auc-dl" style={FIELDS_STYLE}>
                  <Field label="Serial" value={r.battery_serial} />
                  <Field label="Model" value={r.battery_model} />
                  <Field label="Capacity" value={r.battery_capacity} />
                  <Field label="Condition" value={r.battery_condition} />
                  <Field label="Asset state" value={r.battery_state} />
                  <Field label="Warehouse" value={r.battery_warehouse} />
                  <Field
                    label="Held at"
                    value={
                      [r.battery_city, r.battery_state_name]
                        .filter(Boolean)
                        .join(", ") || null
                    }
                  />
                  <Field label="Recovered on" value={date(r.recovery_date)} />
                  <Field
                    label="Photos"
                    value={
                      r.battery_photos > 0 ? (
                        String(r.battery_photos)
                      ) : (
                        <span className="auc-subtle">none yet</span>
                      )
                    }
                  />
                </dl>
                {!r.battery_id ? (
                  <p className="auc-note" style={{ marginBlockStart: "0.5rem" }}>
                    No battery master row for this loan — the flag was raised
                    without a serial, so the asset register stays empty until
                    somebody reads one off the casing at intake.
                  </p>
                ) : null}
              </div>

              <div>
                <div className="auc-label" style={{ marginBlockEnd: "0.5rem" }}>
                  Recovery pipeline
                </div>
                <dl className="auc-dl" style={FIELDS_STYLE}>
                  <Field
                    label="Stage"
                    value={(r.stage ?? "needs_inspection").replace(/_/g, " ")}
                  />
                  <Field
                    label="Estimated recovery value"
                    value={money(r.estimated_recovery_value)}
                  />
                  <Field
                    label="Stage last moved"
                    value={dateTime(r.stage_updated_at)}
                  />
                </dl>
              </div>

              {/* [E-262/E-263] What the agent sent back.
                  This lives in Details as well as in the Action panel on
                  purpose. Action is where a decision is MADE; Details is the
                  record of the row, and a collection whose photographs are only
                  reachable through a button marked "Action" is a record nobody
                  finds when they are not deciding anything. */}
              {a && (a.collected_at || a.visits.length > 0) ? (
                <div>
                  <div className="auc-label" style={{ marginBlockEnd: "0.5rem" }}>
                    What the agent reported
                  </div>

                  {a.collected_at ? (
                    <dl className="auc-dl" style={FIELDS_STYLE}>
                      <Field label="Collected by" value={a.agent_name} />
                      <Field label="Collected at" value={dateTime(a.collected_at)} />
                      <Field
                        label="Location"
                        value={
                          a.gps_lat != null && a.gps_lng != null ? (
                            <a
                              href={`https://www.google.com/maps?q=${a.gps_lat},${a.gps_lng}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {a.gps_lat.toFixed(5)}, {a.gps_lng.toFixed(5)}
                            </a>
                          ) : null
                        }
                      />
                      <Field
                        label="Accuracy"
                        value={
                          a.gps_accuracy_m != null
                            ? `±${Math.round(a.gps_accuracy_m)} m`
                            : null
                        }
                      />
                      <Field
                        label="Distance from address"
                        value={
                          a.distance_from_address_m != null
                            ? `${Math.round(a.distance_from_address_m)} m`
                            : a.has_address_anchor
                              ? null
                              : "address not geocoded"
                        }
                      />
                      <Field label="Condition notes" value={a.condition_notes} />
                    </dl>
                  ) : null}

                  {a.photos.length > 0 ? (
                    <div style={{ marginBlockStart: "0.75rem" }}>
                      <div className="auc-label" style={{ marginBlockEnd: "0.375rem" }}>
                        Photographs ({a.photos.length})
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                        {a.photos.map((ph) => (
                          <a
                            key={ph.id}
                            href={ph.image_url}
                            target="_blank"
                            rel="noreferrer"
                            style={{ display: "block", inlineSize: "8rem" }}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={ph.image_url}
                              alt={PHOTO_LABELS[ph.photo_type] ?? ph.photo_type}
                              style={{
                                inlineSize: "100%",
                                blockSize: "6rem",
                                objectFit: "cover",
                                border: "1px solid var(--auc-rule)",
                              }}
                            />
                            <span
                              className="auc-subtle"
                              style={{ fontSize: "0.6875rem" }}
                            >
                              {PHOTO_LABELS[ph.photo_type] ?? ph.photo_type}
                              {ph.watermark_applied ? "" : " · unstamped"}
                            </span>
                          </a>
                        ))}
                      </div>
                      <p className="auc-note" style={{ marginBlockStart: "0.375rem" }}>
                        Each is stamped with the coordinates and the server&apos;s clock
                        at the moment it was taken.
                      </p>
                    </div>
                  ) : null}

                  {a.visits.length > 0 ? (
                    <div style={{ marginBlockStart: "0.75rem" }}>
                      <div className="auc-label" style={{ marginBlockEnd: "0.375rem" }}>
                        Visits that produced nothing ({a.visits.length})
                      </div>
                      {a.visits.map((v) => (
                        <p
                          key={v.attempt_no}
                          className="auc-note"
                          style={{ marginBlockEnd: "0.25rem" }}
                        >
                          <b>Visit {v.attempt_no}</b> · {dateTime(v.created_at)} ·{" "}
                          {VISIT_OUTCOME_LABELS[v.outcome] ?? v.outcome}
                          {v.gps_lat != null && v.gps_lng != null ? (
                            <>
                              {" · "}
                              <a
                                href={`https://www.google.com/maps?q=${v.gps_lat},${v.gps_lng}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                map
                              </a>
                            </>
                          ) : null}
                          {v.notes ? ` — ${v.notes}` : ""}
                          {v.next_visit_at
                            ? ` · returning ${dateTime(v.next_visit_at)}`
                            : " · not going back"}
                        </p>
                      ))}
                    </div>
                  ) : null}

                  {a.status === "collected" ? (
                    <p className="auc-note" data-tone="warn" style={{ marginBlockStart: "0.5rem" }}>
                      Awaiting your review — approve it from Action to file these
                      photographs against the battery.
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="auc-linkrow">
                <Link href="/nbfc/recovery" className="auc-btn" data-variant="ghost">
                  Move on the recovery board
                </Link>
                <Link
                  href="/nbfc/recovery/batteries"
                  className="auc-btn"
                  data-variant="ghost"
                >
                  Battery register
                </Link>
                <Link
                  href={`/nbfc/leads?q=${encodeURIComponent(
                    r.reference_id ?? r.sanction_id,
                  )}`}
                  className="auc-btn"
                  data-variant="ghost"
                >
                  Open the lead
                </Link>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
