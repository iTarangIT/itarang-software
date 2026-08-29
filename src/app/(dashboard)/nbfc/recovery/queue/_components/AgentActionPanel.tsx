"use client";

/**
 * E-262 — the Action panel: everything the NBFC does to one collection job.
 *
 * It renders by the dispatch's state rather than showing every control at once,
 * because the states are genuinely different situations and a panel that offers
 * Approve on a job nobody has been sent to is noise. The mapping:
 *
 *   nothing yet    pick an agent → Assign
 *   assigned       the link exists but delivery was never confirmed — lead with
 *                  Resend, and show why it failed
 *   in_progress    the agent has it — Copy link, Resend, Cancel, Reassign
 *   collected      photos, GPS, distance and the auto-flags → Approve / Reject
 *   completed      read-only, and where the battery went next
 *   cancelled      who called it off and why, plus Assign again
 *
 * Every action posts and then asks the server component to re-render, so the
 * row's own columns (agent, status) stay in step with this panel. The page is
 * `force-dynamic`, so `router.refresh()` is enough — there is no cache to bust.
 */
import { useState } from "react";
import { formatINR } from "@/components/auction/AuctionPrimitives";
// The label maps live in RecoveryQueueTable, which renders the same evidence in
// the Details panel. One copy, so the two views can never disagree about what
// "battery_missing" is called.
import { PHOTO_LABELS, VISIT_OUTCOME_LABELS } from "./RecoveryQueueTable";
import type {
  AgentOption,
  AssignmentPhoto,
  AutoFlag,
  RecoveryPermissions,
  RecoveryRow,
  VisitAttempt,
} from "./RecoveryQueueTable";

const dash = "—";

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

type Busy = null | "assign" | "resend" | "cancel" | "approve" | "reject" | "reassign";

export default function AgentActionPanel({
  row,
  agents,
  can,
  onChanged,
}: {
  row: RecoveryRow;
  agents: AgentOption[];
  can: RecoveryPermissions;
  onChanged: () => void;
}) {
  const a = row.assignment;

  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(
    null,
  );
  const [agentId, setAgentId] = useState("");
  const [reason, setReason] = useState("");
  const [reviewNotes, setReviewNotes] = useState("");
  const [link, setLink] = useState<string | null>(null);

  // The photographs, the auto-flags and whether the link has lapsed all arrive
  // with the row, decided on the server. This panel holds no clock and fetches
  // nothing on mount: a reviewer sees the evidence the instant they expand.
  const photos: AssignmentPhoto[] = a?.photos ?? [];
  const flags: AutoFlag[] = a?.auto_flags ?? [];
  const linkExpired = a?.link_expired ?? false;
  const visits: VisitAttempt[] = a?.visits ?? [];

  /**
   * The failed journeys, shown on every state that has any.
   *
   * This is the part a disputed repossession turns on — "we attended twice at
   * the agreed time and nobody was there" — so it renders above the controls
   * rather than behind another click, and it renders on a cancelled job too:
   * the visits happened whatever became of the assignment afterwards.
   */
  const visitLog =
    visits.length > 0 ? (
      <div>
        <div className="auc-label" style={{ marginBlockEnd: "0.375rem" }}>
          Visits that produced nothing ({visits.length})
        </div>
        {visits.map((v) => (
          <p
            key={v.attempt_no}
            className="auc-note"
            style={{ marginBlockEnd: "0.25rem" }}
          >
            <b>Visit {v.attempt_no}</b> · {dateTime(v.created_at)} ·{" "}
            {VISIT_OUTCOME_LABELS[v.outcome] ?? v.outcome}
            {v.distance_from_address_m != null
              ? ` · ${Math.round(v.distance_from_address_m)} m from the address`
              : ""}
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
    ) : null;

  async function post(
    url: string,
    body: Record<string, unknown>,
    what: Busy,
  ): Promise<Record<string, unknown> | null> {
    setBusy(what);
    setNote(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || j?.ok === false) {
        setNote({ tone: "error", text: j?.error ?? `HTTP ${res.status}` });
        setBusy(null);
        return null;
      }
      setBusy(null);
      onChanged();
      return j ?? {};
    } catch {
      setNote({ tone: "error", text: "Could not reach the server." });
      setBusy(null);
      return null;
    }
  }

  /** Assign and reassign share a result shape and the same three outcomes. */
  function reportDispatch(res: Record<string, unknown> | null) {
    if (!res) return;
    if (typeof res.link_url === "string") setLink(res.link_url);
    if (res.dispatch_ok) {
      setNote({
        tone: "ok",
        text: `Link sent by ${String(res.dispatch_channel ?? "email")}.`,
      });
    } else {
      setNote({
        tone: "error",
        text: `Assigned, but the link could not be sent: ${String(
          res.dispatch_error ?? "unknown error",
        )}. Copy the link below, or press Resend.`,
      });
    }
  }

  async function assign() {
    if (!agentId) {
      setNote({ tone: "error", text: "Pick an agent first." });
      return;
    }
    const res = await post(
      "/api/nbfc/recovery/assignments",
      { loan_sanction_id: row.sanction_id, agent_id: agentId },
      "assign",
    );
    reportDispatch(res);
  }

  async function reassign() {
    if (!agentId) {
      setNote({ tone: "error", text: "Pick the agent to hand this to." });
      return;
    }
    if (reason.trim().length < 3) {
      setNote({ tone: "error", text: "Say why — the outgoing agent is told." });
      return;
    }
    const res = await post(
      `/api/nbfc/recovery/assignments/${a!.id}/action`,
      { action: "reassign", agent_id: agentId, reason: reason.trim() },
      "reassign",
    );
    reportDispatch(res);
  }

  async function resend() {
    const res = await post(
      `/api/nbfc/recovery/assignments/${a!.id}/action`,
      { action: "resend_link" },
      "resend",
    );
    reportDispatch(res);
  }

  async function cancel() {
    if (reason.trim().length < 3) {
      setNote({ tone: "error", text: "A reason is required — the agent is told it." });
      return;
    }
    const res = await post(
      `/api/nbfc/recovery/assignments/${a!.id}/action`,
      { action: "cancel", reason: reason.trim() },
      "cancel",
    );
    if (res) {
      setNote({
        tone: "ok",
        text: res.notified
          ? "Cancelled. The agent has been told not to collect."
          : `Cancelled, but the agent could not be reached${
              res.notify_error ? `: ${String(res.notify_error)}` : ""
            }. Call them.`,
      });
    }
  }

  async function review(decision: "approve" | "reject") {
    if (decision === "reject" && reviewNotes.trim().length < 3) {
      setNote({ tone: "error", text: "Say what was wrong with the collection." });
      return;
    }
    const res = await post(
      `/api/nbfc/recovery/assignments/${a!.id}/action`,
      { action: "review", decision, notes: reviewNotes.trim() || null },
      decision,
    );
    if (res && decision === "approve") {
      setNote({
        tone: "ok",
        text: `Approved. ${res.photos_attached ?? 0} photo${
          res.photos_attached === 1 ? "" : "s"
        } attached to the battery — it is now at needs inspection.`,
      });
    } else if (res) {
      setNote({ tone: "ok", text: "Rejected. You can dispatch another agent." });
    }
  }

  const agentPicker = (
    <select
      className="auc-input"
      style={{ flex: "1 1 16rem" }}
      value={agentId}
      onChange={(e) => setAgentId(e.target.value)}
    >
      <option value="">Choose a recovery agent…</option>
      {agents.map((ag) => (
        <option key={ag.id} value={ag.id}>
          {ag.name}
          {ag.city ? ` · ${ag.city}` : ""}
          {ag.coverage_area ? ` · ${ag.coverage_area}` : ""}
        </option>
      ))}
    </select>
  );

  const reasonInput = (placeholder: string) => (
    <input
      className="auc-input"
      style={{ flex: "1 1 22rem" }}
      value={reason}
      onChange={(e) => setReason(e.target.value)}
      placeholder={placeholder}
    />
  );

  const linkRow = link ? (
    <div className="auc-action-row">
      <span className="auc-action-label">Collection link</span>
      <input className="auc-input" style={{ flex: "1 1 26rem" }} readOnly value={link} />
      <button
        type="button"
        className="auc-btn"
        data-variant="ghost"
        onClick={() => void navigator.clipboard?.writeText(link)}
      >
        Copy
      </button>
    </div>
  ) : null;

  return (
    <div className="auc-actions">
      {agents.length === 0 ? (
        <div className="auc-empty">
          <p>No recovery agents yet</p>
          <p className="auc-empty-hint">
            Add one under Settings → Recovery Agents. They do not need a login —
            assigning emails them a single-use link that captures their location
            and photographs at the borrower&apos;s address.
          </p>
        </div>
      ) : null}

      {/* ---------------- nothing dispatched yet ---------------- */}
      {!a || a.status === "cancelled" || a.status === "rejected" ? (
        <>
          {a ? (
            <div>
              <div className="auc-label">
                {a.status === "cancelled" ? "Previous attempt cancelled" : "Previous attempt rejected"}
              </div>
              <p className="auc-note" style={{ marginBlockStart: "0.25rem" }}>
                {a.agent_name ?? "An agent"} ·{" "}
                {dateTime(a.cancelled_at ?? a.reviewed_at)}
                {a.cancel_source === "emi_payment"
                  ? " · the borrower paid"
                  : a.cancel_source === "reassigned"
                    ? " · handed to another agent"
                    : ""}
                {a.cancel_reason || a.review_notes
                  ? ` — ${a.cancel_reason ?? a.review_notes}`
                  : ""}
              </p>
            </div>
          ) : null}

          {can.assign ? (
            <>
              {row.dpd === 0 ? (
                <p className="auc-note" data-tone="warn">
                  This loan is current — no EMI is overdue. Sending an agent
                  anyway is allowed, but check you have the right row.
                </p>
              ) : null}
              <div className="auc-action-row">
                <span className="auc-action-label">
                  {a ? "Assign again" : "Assign an agent"}
                </span>
                {agentPicker}
                <button
                  type="button"
                  className="auc-btn"
                  disabled={busy !== null || agents.length === 0}
                  onClick={assign}
                >
                  {busy === "assign" ? "Sending…" : "Assign & send link"}
                </button>
              </div>
              <p className="auc-note">
                Emails the agent a single-use link for{" "}
                {row.borrower_name ?? "the borrower"}
                {row.city ? ` in ${row.city}` : ""}
                {row.battery_serial ? ` · ${row.battery_serial}` : ""}. It expires
                in 7 days.
              </p>
            </>
          ) : (
            <p className="auc-note">Your role cannot dispatch a recovery agent.</p>
          )}
          {linkRow}
        </>
      ) : null}

      {/* ---------------- dispatched, not yet collected ---------------- */}
      {a && (a.status === "assigned" || a.status === "in_progress") ? (
        <>
          <div className="auc-dl" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(11rem, 1fr))" }}>
            <div>
              <dt>Agent</dt>
              <dd>
                {a.agent_name ?? dash}
                {a.agent_phone ? ` · ${a.agent_phone}` : ""}
              </dd>
            </div>
            <div>
              <dt>Assigned</dt>
              <dd>{dateTime(a.assigned_at)}</dd>
            </div>
            <div>
              <dt>Link sent</dt>
              <dd>
                {a.link_sent_at
                  ? `${dateTime(a.link_sent_at)}${a.link_channel ? ` · ${a.link_channel}` : ""}`
                  : "not confirmed"}
              </dd>
            </div>
            <div>
              <dt>Link expires</dt>
              <dd>
                {linkExpired ? (
                  <span className="auc-chip" data-tone="warn">
                    expired
                  </span>
                ) : (
                  dateTime(a.link_expires_at)
                )}
              </dd>
            </div>
            <div>
              <dt>Attempt</dt>
              <dd>#{a.attempt_no}</dd>
            </div>
          </div>

          {a.next_visit_at ? (
            <p className="auc-note" data-tone="warn">
              {a.agent_name ?? "The agent"} could not collect and will return on{" "}
              <b>{dateTime(a.next_visit_at)}</b>. Their link still works.
            </p>
          ) : null}

          {visitLog}

          {a.status === "assigned" ? (
            <p className="auc-note" data-tone="warn">
              The link was created but nothing confirmed it reached{" "}
              {a.agent_name ?? "the agent"}
              {a.dispatch_error ? ` — ${a.dispatch_error}` : ""}. Resend it, or
              copy it and send it yourself.
            </p>
          ) : null}

          <div className="auc-action-row">
            <span className="auc-action-label">Link</span>
            <button
              type="button"
              className="auc-btn"
              disabled={busy !== null || !can.assign}
              onClick={resend}
            >
              {busy === "resend" ? "Sending…" : "Resend link"}
            </button>
            <span className="auc-note">
              Sends a fresh link on a new 7-day window.
            </span>
          </div>
          {linkRow}

          {can.cancel ? (
            <div className="auc-action-row">
              <span className="auc-action-label">Cancel recovery</span>
              {reasonInput("Why is this being called off? The agent is told.")}
              <button
                type="button"
                className="auc-btn"
                data-variant="danger"
                disabled={busy !== null}
                onClick={cancel}
              >
                {busy === "cancel" ? "Cancelling…" : "Cancel & tell the agent"}
              </button>
            </div>
          ) : null}

          {can.assign ? (
            <div className="auc-action-row">
              <span className="auc-action-label">Reassign</span>
              {agentPicker}
              <button
                type="button"
                className="auc-btn"
                data-variant="ghost"
                disabled={busy !== null}
                onClick={reassign}
              >
                {busy === "reassign" ? "Handing over…" : "Hand to this agent"}
              </button>
              <span className="auc-note">
                Cancels {a.agent_name ?? "the current agent"} first and tells them
                not to collect. Uses the reason above.
              </span>
            </div>
          ) : null}
        </>
      ) : null}

      {a && (a.status === "cancelled" || a.status === "rejected" || a.status === "collected" || a.status === "completed")
        ? visitLog
        : null}

      {/* ---------------- collected, awaiting review ---------------- */}
      {a && a.status === "collected" ? (
        <>
          <div className="auc-dl" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(11rem, 1fr))" }}>
            <div>
              <dt>Collected by</dt>
              <dd>{a.agent_name ?? dash}</dd>
            </div>
            <div>
              <dt>Collected at</dt>
              <dd>{dateTime(a.collected_at)}</dd>
            </div>
            <div>
              <dt>Distance from address</dt>
              <dd>
                {a.distance_from_address_m != null
                  ? `${Math.round(a.distance_from_address_m)} m`
                  : a.has_address_anchor
                    ? dash
                    : "address not geocoded"}
              </dd>
            </div>
            <div>
              <dt>Location accuracy</dt>
              <dd>
                {a.gps_accuracy_m != null ? `±${Math.round(a.gps_accuracy_m)} m` : dash}
              </dd>
            </div>
            <div>
              <dt>Battery serial</dt>
              <dd>{row.battery_serial ?? dash}</dd>
            </div>
            {a.gps_lat != null && a.gps_lng != null ? (
              <div>
                <dt>Map</dt>
                <dd>
                  <a
                    href={`https://www.google.com/maps?q=${a.gps_lat},${a.gps_lng}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {a.gps_lat.toFixed(5)}, {a.gps_lng.toFixed(5)}
                  </a>
                </dd>
              </div>
            ) : null}
          </div>

          {a.condition_notes ? (
            <div>
              <div className="auc-label">Condition, as the agent found it</div>
              <p style={{ marginBlockStart: "0.25rem", fontSize: "0.875rem", lineHeight: 1.6 }}>
                {a.condition_notes}
              </p>
            </div>
          ) : null}

          {flags.length > 0 ? (
            <div>
              <div className="auc-label" style={{ marginBlockEnd: "0.375rem" }}>
                Worth a look
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
                {flags.map((f) => (
                  <span
                    key={f.key}
                    className="auc-chip"
                    data-tone={f.severity === "red" ? "warn" : "muted"}
                  >
                    {f.label}
                  </span>
                ))}
              </div>
              <p className="auc-note" style={{ marginBlockStart: "0.375rem" }}>
                These are flags, not verdicts. You decide.
              </p>
            </div>
          ) : null}

          {photos.length > 0 ? (
            <div>
              <div className="auc-label" style={{ marginBlockEnd: "0.375rem" }}>
                Photographs ({photos.length})
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                {photos.map((ph) => (
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
                    <span className="auc-subtle" style={{ fontSize: "0.6875rem" }}>
                      {PHOTO_LABELS[ph.photo_type] ?? ph.photo_type}
                      {ph.watermark_applied ? "" : " · unstamped"}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          ) : (
            <p className="auc-note">No photographs were uploaded.</p>
          )}

          {can.review ? (
            <>
              <div className="auc-action-row">
                <span className="auc-action-label">Review note</span>
                <input
                  className="auc-input"
                  style={{ flex: "1 1 22rem" }}
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  placeholder="Optional on approve, required on reject."
                />
              </div>
              <div className="auc-action-row">
                <span className="auc-action-label">Decision</span>
                <button
                  type="button"
                  className="auc-btn"
                  disabled={busy !== null}
                  onClick={() => review("approve")}
                >
                  {busy === "approve" ? "Approving…" : "Approve collection"}
                </button>
                <button
                  type="button"
                  className="auc-btn"
                  data-variant="ghost"
                  disabled={busy !== null}
                  onClick={() => review("reject")}
                >
                  {busy === "reject" ? "Rejecting…" : "Reject"}
                </button>
                <span className="auc-note">
                  Approving files the photographs against the battery, stamps
                  where and when it was recovered, and leaves it at needs
                  inspection for the evaluation wizard.
                </span>
              </div>
            </>
          ) : (
            <p className="auc-note">
              Your role cannot approve a collection — a risk head or NBFC admin
              signs this off.
            </p>
          )}
        </>
      ) : null}

      {/* ---------------- done ---------------- */}
      {a && a.status === "completed" ? (
        <>
          <div className="auc-dl" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(11rem, 1fr))" }}>
            <div>
              <dt>Collected by</dt>
              <dd>{a.agent_name ?? dash}</dd>
            </div>
            <div>
              <dt>Collected at</dt>
              <dd>{dateTime(a.collected_at)}</dd>
            </div>
            <div>
              <dt>Approved</dt>
              <dd>{dateTime(a.reviewed_at)}</dd>
            </div>
            <div>
              <dt>Photos on the battery</dt>
              <dd>{row.battery_photos || photos.length || 0}</dd>
            </div>
          </div>
          {a.review_notes ? (
            <p className="auc-note">{a.review_notes}</p>
          ) : null}
          <p className="auc-note">
            The battery is in the register at <b>needs inspection</b>. Open the
            recovery board to evaluate it.
          </p>
        </>
      ) : null}

      {note ? (
        <p
          className={note.tone === "error" ? "auc-inline-error" : "auc-note"}
          data-tone={note.tone === "error" ? "warn" : "ok"}
        >
          {note.text}
        </p>
      ) : null}

      <p className="auc-subtle" style={{ fontSize: "0.6875rem" }}>
        Outstanding {row.outstanding != null ? formatINR(row.outstanding) : dash} ·
        DPD {row.dpd ?? dash} · flagged {row.flagged_at ? dateTime(row.flagged_at) : dash}
      </p>
    </div>
  );
}
