/**
 * Pacing rules (doc §6.3). Pure: callers pass `now`, the account's settings
 * and today's counts from li_action_log, so a restart can never exceed a cap
 * (acceptance test 3) — the counts come from the log, not from memory.
 *
 * All wall-clock rules are in IST (Asia/Kolkata, UTC+05:30, no DST).
 */

export type PacingSettings = {
  invites_per_day: number;
  messages_per_day: number;
  gap_min_minutes: number;
  gap_max_minutes: number;
  send_start: string; // "HH:MM" IST
  send_end: string;
  send_days: string; // "1,2,3,4,5,6" — ISO weekday, 1 = Monday
  warmup_week1_invites: number;
  warmup_week2_invites: number;
  poll_interval_minutes: number;
  invite_expiry_days: number;
};

export const DEFAULT_SETTINGS: PacingSettings = {
  invites_per_day: 15,
  messages_per_day: 30,
  gap_min_minutes: 3,
  gap_max_minutes: 9,
  send_start: "10:00",
  send_end: "18:30",
  send_days: "1,2,3,4,5,6",
  warmup_week1_invites: 5,
  warmup_week2_invites: 10,
  poll_interval_minutes: 45,
  invite_expiry_days: 21,
};

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** IST wall-clock parts of an instant. */
export function istParts(now: Date): { isoWeekday: number; minutes: number; dateKey: string } {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const dow = ist.getUTCDay(); // 0 = Sunday
  return {
    isoWeekday: dow === 0 ? 7 : dow,
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
    dateKey: ist.toISOString().slice(0, 10),
  };
}

/** The UTC instant of the most recent IST midnight — start of "today" for caps. */
export function istDayStart(now: Date): Date {
  const ist = now.getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(ist / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

function hhmm(s: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return fallback;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
}

export function sendDays(s: PacingSettings): Set<number> {
  return new Set(
    s.send_days
      .split(",")
      .map((d) => Number(d.trim()))
      .filter((d) => d >= 1 && d <= 7),
  );
}

export function inSendingWindow(s: PacingSettings, now: Date): boolean {
  const { isoWeekday, minutes } = istParts(now);
  if (!sendDays(s).has(isoWeekday)) return false;
  const start = hhmm(s.send_start, 600);
  const end = hhmm(s.send_end, 1110);
  return minutes >= start && minutes < end;
}

/** Today's invite cap, with warm-up for a new account (week 1, week 2, then full). */
export function inviteCap(s: PacingSettings, warmupStartedAt: Date | null, now: Date): number {
  const full = Math.max(0, s.invites_per_day);
  if (!warmupStartedAt) return full;
  const days = Math.floor((now.getTime() - warmupStartedAt.getTime()) / DAY_MS);
  if (days < 7) return Math.min(full, Math.max(0, s.warmup_week1_invites));
  if (days < 14) return Math.min(full, Math.max(0, s.warmup_week2_invites));
  return full;
}

export type TodayCounts = { invites: number; messages: number };

export type SendDecision =
  | { ok: true }
  | { ok: false; reason: "outside_hours" | "invite_cap" | "message_cap" | "too_soon" };

/**
 * May this account take `action` now? `lastActionAt` is the latest invite /
 * message / reply in the log — the random gap is measured from it.
 * `gapMs` is the gap drawn for this account (see randomGapMs).
 */
export function canAct(args: {
  settings: PacingSettings;
  action: "invite" | "message";
  counts: TodayCounts;
  warmupStartedAt: Date | null;
  lastActionAt: Date | null;
  gapMs: number;
  now: Date;
}): SendDecision {
  const { settings: s, action, counts, now } = args;
  if (!inSendingWindow(s, now)) return { ok: false, reason: "outside_hours" };
  if (action === "invite" && counts.invites >= inviteCap(s, args.warmupStartedAt, now)) {
    return { ok: false, reason: "invite_cap" };
  }
  if (action === "message" && counts.messages >= Math.max(0, s.messages_per_day)) {
    return { ok: false, reason: "message_cap" };
  }
  if (args.lastActionAt && now.getTime() - args.lastActionAt.getTime() < args.gapMs) {
    return { ok: false, reason: "too_soon" };
  }
  return { ok: true };
}

/** A random gap between gap_min and gap_max minutes. `rand` injectable for tests. */
export function randomGapMs(s: PacingSettings, rand: () => number = Math.random): number {
  const lo = Math.max(0, Math.min(s.gap_min_minutes, s.gap_max_minutes));
  const hi = Math.max(lo, s.gap_max_minutes);
  return Math.round((lo + (hi - lo) * rand()) * 60_000);
}

/**
 * Deterministic per-(account, last action) gap, so every tick between two
 * actions sees the SAME gap rather than re-rolling until a short one comes up.
 */
export function gapFor(s: PacingSettings, seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const unit = ((h >>> 0) % 10_000) / 10_000;
  return randomGapMs(s, () => unit);
}

/** Should the poll run now for this account? Sending hours only. */
export function pollDue(s: PacingSettings, lastPolledAt: Date | null, now: Date): boolean {
  if (!inSendingWindow(s, now)) return false;
  if (!lastPolledAt) return true;
  return now.getTime() - lastPolledAt.getTime() >= Math.max(5, s.poll_interval_minutes) * 60_000;
}

export function inviteExpired(s: PacingSettings, inviteSentAt: Date | null, now: Date): boolean {
  if (!inviteSentAt) return false;
  return now.getTime() - inviteSentAt.getTime() >= Math.max(1, s.invite_expiry_days) * DAY_MS;
}
