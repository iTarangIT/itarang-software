"use client";

/**
 * The refurbishment workshop console — BRD §5, §15.
 *
 * `recovery/refurbishment.ts` is 444 lines of finished service: the four-state
 * lifecycle, the one-open-job-per-battery guard, the mandatory-new accessories
 * with their prices, and the cost roll-up that feeds a lot's base price. Three
 * routes expose it. Nothing had ever called them, so a job could only be raised
 * with curl and the whole "recommended, never mandatory" repair loop existed on
 * paper only.
 *
 * WHAT THE STATES DRAG WITH THEM
 *   requested   → battery `refurbishing`, case `refurbishable`
 *   returned    → battery `ready` + grade `refurbished`, case `ready_for_auction`
 *   cancelled   → battery `inspected`, case `needs_inspection` (deliberately
 *                 NOT `ready`: nothing was actually repaired)
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { nbfcFetch, formatINR } from "@/lib/auction/client";

interface Accessory {
  key: string;
  label: string;
  unit_cost: number;
  included: boolean;
}

interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  note?: string | null;
}

interface Job {
  id: string;
  battery_id: string;
  battery_serial: string | null;
  assigned_workshop: string | null;
  checklist: ChecklistItem[];
  accessories: Accessory[];
  estimated_cost: number | null;
  actual_cost: number | null;
  total_cost: number | null;
  status: string;
  notes: string | null;
  requested_at: string;
  started_at: string | null;
  returned_at: string | null;
}

const FILTERS = [
  { key: "open", label: "Open" },
  { key: "requested", label: "Requested" },
  { key: "in_progress", label: "In workshop" },
  { key: "returned", label: "Returned" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
] as const;

/** requested → in_progress → returned, with cancel available from both. */
const NEXT: Record<string, Array<{ status: string; label: string }>> = {
  requested: [
    { status: "in_progress", label: "Start work" },
    { status: "cancelled", label: "Cancel" },
  ],
  in_progress: [
    { status: "returned", label: "Mark returned" },
    { status: "cancelled", label: "Cancel" },
  ],
  returned: [],
  cancelled: [],
};

const TONE: Record<string, string> = {
  returned: "live",
  cancelled: "warn",
  in_progress: "warn",
};

interface Candidate {
  id: string;
  serial: string;
  condition_grade: string | null;
  state_code: string;
}

export default function RefurbishmentConsole() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftCost, setDraftCost] = useState("");
  const [draftWorkshop, setDraftWorkshop] = useState("");

  // — raise a job —
  const [raising, setRaising] = useState(false);
  const [newBattery, setNewBattery] = useState("");
  const [newWorkshop, setNewWorkshop] = useState("");
  const [newEstimate, setNewEstimate] = useState("");
  const [savingNew, setSavingNew] = useState(false);

  // Only batteries that have been graded can go to the workshop. `inspected`
  // and `ready` are the two states the service accepts; anything scrapped,
  // lotted or sold is refused with a readable message.
  const candidatesQuery = useQuery({
    queryKey: ["auction", "nbfc", "refurb-candidates"],
    queryFn: async () => {
      const [inspected, ready] = await Promise.all([
        nbfcFetch<{ items: Candidate[] }>(
          "/api/nbfc/recovery/batteries?state=inspected",
        ),
        nbfcFetch<{ items: Candidate[] }>(
          "/api/nbfc/recovery/batteries?state=ready",
        ),
      ]);
      return [...inspected.items, ...ready.items];
    },
    enabled: raising,
  });

  async function raiseJob() {
    if (!newBattery) {
      toast.error("Pick a battery first.");
      return;
    }
    setSavingNew(true);
    try {
      const body: Record<string, unknown> = { battery_id: newBattery };
      if (newWorkshop.trim()) body.assigned_workshop = newWorkshop.trim();
      if (newEstimate.trim()) body.estimated_cost = Number(newEstimate);

      await nbfcFetch("/api/nbfc/recovery/refurbishment", {
        method: "POST",
        body: JSON.stringify(body),
      });
      toast.success("Job raised — the battery is now in the workshop");
      setNewBattery("");
      setNewWorkshop("");
      setNewEstimate("");
      setRaising(false);
      qc.invalidateQueries({ queryKey: ["auction", "nbfc"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingNew(false);
    }
  }

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["auction", "nbfc", "refurbishment", filter],
    queryFn: () =>
      nbfcFetch<{ items: Job[] }>(
        `/api/nbfc/recovery/refurbishment?status=${filter}`,
      ),
    refetchOnWindowFocus: true,
  });

  async function patch(job: Job, body: Record<string, unknown>, label: string) {
    setBusy(job.id);
    try {
      await nbfcFetch(`/api/nbfc/recovery/refurbishment/${job.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      toast.success(label);
      qc.invalidateQueries({ queryKey: ["auction", "nbfc"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function advance(job: Job, status: string, label: string) {
    if (status === "cancelled") {
      const ok = await confirmDialog({
        title: "Cancel this job?",
        message:
          "The battery goes back to inspected, not to ready — nothing was " +
          "repaired, so it must be graded again before it can be sold.",
        confirmText: "Cancel job",
        variant: "danger",
      });
      if (!ok) return;
    }
    if (status === "returned" && job.actual_cost == null) {
      const ok = await confirmDialog({
        title: "Return without an actual cost?",
        message:
          "Only returned jobs contribute to a lot's base price. Without an " +
          "actual cost the estimate is used, and the repair may be underpriced.",
        confirmText: "Return anyway",
      });
      if (!ok) return;
    }
    await patch(job, { status }, label);
  }

  function toggleAccessory(job: Job, key: string) {
    const next = job.accessories.map((a) =>
      a.key === key ? { ...a, included: !a.included } : a,
    );
    void patch(job, { accessories: next }, "Accessories updated");
  }

  function toggleChecklist(job: Job, key: string) {
    const next = job.checklist.map((c) =>
      c.key === key ? { ...c, done: !c.done } : c,
    );
    void patch(job, { checklist: next }, "Checklist updated");
  }

  const jobs = data?.items ?? [];

  return (
    <>
      <div className="auc-toolbar">
        <div className="auc-tabs" role="tablist" style={{ flex: "1 1 auto" }}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              className="auc-tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="auc-toolbar-end">
          <button
            type="button"
            className="auc-btn"
            onClick={() => setRaising((v) => !v)}
          >
            {raising ? "Close" : "Raise a job"}
          </button>
        </div>
      </div>

      {raising ? (
        <section className="auc-panel" style={{ marginBlockEnd: "1.5rem" }}>
          <header>
            <span className="auc-panel-n">＋</span>
            <h3>New refurbishment job</h3>
          </header>
          <div className="auc-panel-body">
            <div className="auc-field">
              <label htmlFor="rj-battery">Battery</label>
              <select
                id="rj-battery"
                className="auc-text"
                value={newBattery}
                onChange={(e) => setNewBattery(e.target.value)}
              >
                <option value="">
                  {candidatesQuery.isLoading
                    ? "Loading…"
                    : "Select a graded battery"}
                </option>
                {(candidatesQuery.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.serial}
                    {c.condition_grade ? ` — ${c.condition_grade}` : ""} (
                    {c.state_code})
                  </option>
                ))}
              </select>
              <span className="auc-hint">
                Only inspected or ready stock. A battery may have one open job
                at a time, and one below the 70 % refurbishment threshold is
                refused — grade it partial working and sell it as it is.
              </span>
            </div>

            <div className="auc-dl" style={{ gap: "0.875rem" }}>
              <div className="auc-field">
                <label htmlFor="rj-workshop">Workshop</label>
                <input
                  id="rj-workshop"
                  className="auc-text"
                  value={newWorkshop}
                  onChange={(e) => setNewWorkshop(e.target.value)}
                />
              </div>
              <div className="auc-field">
                <label htmlFor="rj-estimate">Estimated cost</label>
                <input
                  id="rj-estimate"
                  className="auc-text"
                  data-numeric="true"
                  inputMode="numeric"
                  value={newEstimate}
                  onChange={(e) =>
                    setNewEstimate(e.target.value.replace(/[^\d.]/g, ""))
                  }
                />
              </div>
            </div>

            <span className="auc-hint">
              The three mandatory new accessories — charger, wiring harness and
              SOC meter — are added automatically and can be unticked per job.
            </span>

            <div className="auc-linkrow">
              <button
                type="button"
                className="auc-btn"
                disabled={savingNew}
                onClick={raiseJob}
              >
                {savingNew ? "Raising…" : "Raise job"}
              </button>
              <button
                type="button"
                className="auc-btn"
                data-variant="ghost"
                onClick={() => setRaising(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {isLoading ? (
        <div className="auc-stack" style={{ marginBlockStart: "1.25rem" }}>
          {[0, 1].map((i) => (
            <div key={i} className="auc-skel" style={{ height: "9rem" }} />
          ))}
        </div>
      ) : isError ? (
        <div className="auc-inline-error" style={{ marginBlockStart: "1.25rem" }}>
          {(error as Error).message}
        </div>
      ) : jobs.length === 0 ? (
        <div className="auc-empty" style={{ marginBlockStart: "1.25rem" }}>
          <p>No {filter === "all" ? "" : FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} jobs</p>
          <p className="auc-empty-hint">
            Raise a refurbishment job from a battery on the recovery board.
            Repair is recommended, never mandatory — a battery graded partial
            working can go straight to auction without passing through the
            workshop at all.
          </p>
        </div>
      ) : (
        <div className="auc-stack" style={{ marginBlockStart: "1.25rem" }}>
          {jobs.map((job) => {
            const accessoriesTotal = job.accessories
              .filter((a) => a.included)
              .reduce((s, a) => s + a.unit_cost, 0);
            const labour = job.actual_cost ?? job.estimated_cost ?? 0;
            const variance =
              job.actual_cost != null && job.estimated_cost != null
                ? job.actual_cost - job.estimated_cost
                : null;

            return (
              <article key={job.id} className="auc-mini-card">
                <header>
                  <div className="auc-winner">
                    <span className="auc-pick-serial">
                      {job.battery_serial ?? job.battery_id.slice(0, 8)}
                    </span>
                    {job.assigned_workshop ? (
                      <span className="auc-subtle">
                        {job.assigned_workshop}
                      </span>
                    ) : null}
                  </div>
                  <span className="auc-chip" data-tone={TONE[job.status]}>
                    {job.status.replace("_", " ")}
                  </span>
                </header>

                <dl className="auc-dl">
                  <div>
                    <dt>Estimated</dt>
                    <dd className="auc-num">{formatINR(job.estimated_cost)}</dd>
                  </div>
                  <div>
                    <dt>Actual</dt>
                    <dd className="auc-num">{formatINR(job.actual_cost)}</dd>
                  </div>
                  <div>
                    <dt>Variance</dt>
                    <dd
                      className="auc-num"
                      style={
                        variance != null && variance > 0
                          ? { color: "var(--auc-warn)" }
                          : undefined
                      }
                    >
                      {variance == null
                        ? "—"
                        : `${variance >= 0 ? "+" : ""}${formatINR(variance)}`}
                    </dd>
                  </div>
                  <div>
                    <dt>Requested</dt>
                    <dd className="auc-subtle">
                      {new Date(job.requested_at).toLocaleDateString("en-IN")}
                    </dd>
                  </div>
                </dl>

                {/* Accessories — BRD §15: always new, costed separately, then
                    rolled into the lot's base price so the dealer sees one
                    number. */}
                <div style={{ marginBlockStart: "0.875rem" }}>
                  <span className="auc-label">Accessories — new, mandatory</span>
                  <div className="auc-ledger" style={{ marginBlockStart: "0.5rem" }}>
                    {job.accessories.map((a) => (
                      <div key={a.key} className="auc-ledger-row">
                        <label
                          style={{
                            display: "flex",
                            gap: "0.5rem",
                            alignItems: "center",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={a.included}
                            disabled={
                              busy === job.id ||
                              job.status === "returned" ||
                              job.status === "cancelled"
                            }
                            onChange={() => toggleAccessory(job, a.key)}
                          />
                          {a.label}
                        </label>
                        <b>{formatINR(a.unit_cost)}</b>
                      </div>
                    ))}
                    <div className="auc-ledger-row">
                      <span>Labour</span>
                      <b>{formatINR(labour)}</b>
                    </div>
                    <div className="auc-ledger-row" data-total="true">
                      <span>Rolls into base price</span>
                      <b>{formatINR(labour + accessoriesTotal)}</b>
                    </div>
                  </div>
                  {job.status !== "returned" ? (
                    <span className="auc-hint">
                      Counted only once the job is <b>returned</b> — an open job
                      contributes nothing, so a lot can never be priced on work
                      that has not happened.
                    </span>
                  ) : null}
                </div>

                {job.checklist.length > 0 ? (
                  <div style={{ marginBlockStart: "0.875rem" }}>
                    <span className="auc-label">Checklist</span>
                    <div className="auc-ledger" style={{ marginBlockStart: "0.5rem" }}>
                      {job.checklist.map((c) => (
                        <div key={c.key} className="auc-ledger-row">
                          <label
                            style={{
                              display: "flex",
                              gap: "0.5rem",
                              alignItems: "center",
                              cursor: "pointer",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={c.done}
                              disabled={
                                busy === job.id ||
                                job.status === "returned" ||
                                job.status === "cancelled"
                              }
                              onChange={() => toggleChecklist(job, c.key)}
                            />
                            {c.label}
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {editing === job.id ? (
                  <div style={{ marginBlockStart: "0.875rem" }}>
                    <div className="auc-field">
                      <label htmlFor={`cost-${job.id}`}>Actual cost</label>
                      <input
                        id={`cost-${job.id}`}
                        className="auc-text"
                        data-numeric="true"
                        inputMode="numeric"
                        value={draftCost}
                        onChange={(e) =>
                          setDraftCost(e.target.value.replace(/[^\d.]/g, ""))
                        }
                      />
                    </div>
                    <div className="auc-field" style={{ marginBlockStart: "0.5rem" }}>
                      <label htmlFor={`ws-${job.id}`}>Workshop</label>
                      <input
                        id={`ws-${job.id}`}
                        className="auc-text"
                        value={draftWorkshop}
                        onChange={(e) => setDraftWorkshop(e.target.value)}
                      />
                    </div>
                    <div className="auc-linkrow" style={{ marginBlockStart: "0.625rem" }}>
                      <button
                        type="button"
                        className="auc-btn"
                        disabled={busy === job.id}
                        onClick={async () => {
                          const body: Record<string, unknown> = {};
                          body.actual_cost = draftCost.trim()
                            ? Number(draftCost)
                            : null;
                          body.assigned_workshop =
                            draftWorkshop.trim() || null;
                          await patch(job, body, "Job updated");
                          setEditing(null);
                        }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="auc-btn"
                        data-variant="ghost"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="auc-linkrow" style={{ marginBlockStart: "0.875rem" }}>
                    {(NEXT[job.status] ?? []).map((n) => (
                      <button
                        key={n.status}
                        type="button"
                        className="auc-btn"
                        data-variant={n.status === "cancelled" ? "ghost" : undefined}
                        disabled={busy === job.id}
                        onClick={() => advance(job, n.status, `${n.label} — done`)}
                      >
                        {n.label}
                      </button>
                    ))}
                    {job.status !== "returned" && job.status !== "cancelled" ? (
                      <button
                        type="button"
                        className="auc-btn"
                        data-variant="ghost"
                        onClick={() => {
                          setEditing(job.id);
                          setDraftCost(
                            job.actual_cost != null ? String(job.actual_cost) : "",
                          );
                          setDraftWorkshop(job.assigned_workshop ?? "");
                        }}
                      >
                        Edit cost / workshop
                      </button>
                    ) : null}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
