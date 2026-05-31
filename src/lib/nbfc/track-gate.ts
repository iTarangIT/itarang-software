/**
 * Unified verification-track gate — BRD Addendum V0.2 §7.4 (Track Rules).
 *
 * A winning NBFC runs up to three verification tracks for a lead: Field
 * Investigation (§6.3), Active Video KYC (§10) and E-NACH (§9). Which tracks
 * apply is frozen in the per-lead service-config SNAPSHOT taken when the lead
 * bound to the NBFC (§7.4) — never live config, so a later settings edit cannot
 * disturb an in-flight lead.
 *
 * Two per-NBFC Track Rules (also snapshotted) govern disbursal:
 *
 *   • track_completion_gate — whether ALL opted-in tracks must reach a passing
 *     terminal state before financing conditions (sanction/disbursal). Default ON.
 *   • track_failure_halts   — whether a FAILED track halts the sibling tracks
 *     (vs. letting them continue). Default OFF. Enforced at track INITIATION
 *     (`assertNotHaltedByFailure`), not here.
 *
 * E-NACH is special: when enabled & not waived it is a HARD disbursal gate in
 * its own right (§9.4), independent of track_completion_gate. We therefore
 * always require the E-NACH gate to be satisfied, and additionally require FI +
 * VKYC completion only when track_completion_gate is ON.
 */
import { evaluateEnachGate, getWinningAssignment } from "@/lib/nbfc/enach";
import { getFiTrack } from "@/lib/nbfc/fi";
import { getVkycTrack } from "@/lib/nbfc/vkyc";

export type TrackKey = "fi" | "vkyc" | "enach";

export interface TrackState {
  key: TrackKey;
  /** Opted-in for the winning NBFC (per the lead's frozen snapshot). */
  required: boolean;
  /** Canonical status string (track-specific), or null when no row exists yet. */
  status: string | null;
  /** Reached a passing terminal state (FI pass / VKYC verified / E-NACH registered|waived). */
  complete: boolean;
  /** Reached a failing terminal state. */
  failed: boolean;
}

export interface TrackGate {
  /** Disbursal may proceed. */
  satisfied: boolean;
  reason: string;
  /** The two snapshotted Track Rules in force for this lead. */
  completion_gate: boolean;
  failure_halts: boolean;
  /** At least one required track is in a failing terminal state. */
  blocked_by_failure: boolean;
  tracks: TrackState[];
}

interface Snapshot {
  fi_enabled?: boolean;
  vkyc_enabled?: boolean;
  enach_enabled?: boolean;
  track_completion_gate?: boolean;
  track_failure_halts?: boolean;
}

/**
 * Evaluates the unified disbursal gate for a lead's winning NBFC. With no
 * winner the gate is vacuously satisfied (the caller enforces winner selection
 * separately). The E-NACH portion reuses `evaluateEnachGate` so the §9.4 hard
 * gate (and its per-lead waiver) stays the single source of truth.
 */
export async function evaluateTrackGate(leadId: string): Promise<TrackGate> {
  const winner = await getWinningAssignment(leadId);
  if (!winner) {
    return {
      satisfied: true,
      reason: "No winning NBFC selected.",
      completion_gate: true,
      failure_halts: false,
      blocked_by_failure: false,
      tracks: [],
    };
  }

  const snap = (winner.snapshot ?? {}) as Snapshot;
  const completionGate = snap.track_completion_gate ?? true;
  const failureHalts = snap.track_failure_halts ?? false;

  // FI (winning NBFC's row). complete = status 'completed' with outcome 'pass'.
  const fiRequired = snap.fi_enabled ?? false;
  const fiRow = fiRequired ? await getFiTrack(leadId, winner.nbfc_id) : null;
  const fiStatus = fiRow?.status ?? null;
  const fiState: TrackState = {
    key: "fi",
    required: fiRequired,
    status: fiStatus,
    complete: fiStatus === "completed" && fiRow?.outcome === "pass",
    failed: fiStatus === "failed" || fiRow?.outcome === "fail",
  };

  // VKYC (winning NBFC's row). complete = 'verified'.
  const vkycRequired = snap.vkyc_enabled ?? false;
  const vkycRow = vkycRequired ? await getVkycTrack(leadId, winner.nbfc_id) : null;
  const vkycStatus = vkycRow?.status ?? null;
  const vkycState: TrackState = {
    key: "vkyc",
    required: vkycRequired,
    status: vkycStatus,
    complete: vkycStatus === "verified",
    failed: vkycStatus === "failed",
  };

  // E-NACH — the §9.4 hard gate (registered or waived satisfies).
  const enach = await evaluateEnachGate(leadId);
  const enachState: TrackState = {
    key: "enach",
    required: enach.required,
    status: enach.status,
    complete: enach.satisfied,
    failed: enach.status === "failed",
  };

  const tracks = [fiState, vkycState, enachState];
  const requiredTracks = tracks.filter((t) => t.required);
  const blockedByFailure = requiredTracks.some((t) => t.failed);

  // E-NACH always gates when required (§9.4). FI + VKYC gate only when the
  // completion-gate Track Rule is ON.
  const enachOk = enachState.complete || !enachState.required;
  const completionTracks = [fiState, vkycState].filter((t) => t.required);
  const completionOk = !completionGate || completionTracks.every((t) => t.complete);

  const satisfied = enachOk && completionOk;

  let reason: string;
  if (satisfied) {
    reason = "All applicable verification tracks satisfied.";
  } else if (!enachOk) {
    reason = enach.reason;
  } else {
    const pending = completionTracks
      .filter((t) => !t.complete)
      .map((t) => (t.failed ? `${t.key} failed` : `${t.key} incomplete`));
    reason = `Completion gate: ${pending.join(", ")} — all opted-in tracks must complete before disbursal.`;
  }

  return {
    satisfied,
    reason,
    completion_gate: completionGate,
    failure_halts: failureHalts,
    blocked_by_failure: blockedByFailure,
    tracks,
  };
}

/**
 * §7.4 track-failure-halt — throws when `track_failure_halts` is in force for
 * this lead and a SIBLING required track has already failed, so a new attempt
 * on the `current` track must not start. No-op when the rule is off or nothing
 * has failed. Call at the head of each track's initiate handler.
 *
 * `current` is excluded so a failed track can still be retried on its own
 * (retries are explicitly unlimited for E-NACH, §9.4) — halting concerns the
 * OTHER tracks.
 */
export async function assertNotHaltedByFailure(leadId: string, current: TrackKey): Promise<void> {
  const gate = await evaluateTrackGate(leadId);
  if (!gate.failure_halts) return;
  const siblingFailed = gate.tracks.some((t) => t.key !== current && t.required && t.failed);
  if (siblingFailed) {
    const who = gate.tracks
      .filter((t) => t.key !== current && t.required && t.failed)
      .map((t) => t.key)
      .join(", ");
    throw new Error(
      `BAD_REQUEST: track halted — a sibling verification track (${who}) has failed and this NBFC's Track Rules halt the others.`,
    );
  }
}
