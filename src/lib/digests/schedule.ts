/**
 * Digest scheduling and settings — the pure half (E-287, generalised by E-288).
 *
 * Split from settings.ts for the same reason operations/scheduling.ts was split
 * from runner.ts: the settings store imports `db`, and vitest here is
 * deliberately scoped to no-I/O tests, so logic sitting beside a database import
 * cannot be unit tested. The two things most worth pinning — WHEN a slot is due
 * (all the IST-vs-UTC edges) and what a valid setting IS — live here.
 *
 * TIMES ARE IST WALL-CLOCK, in whole hours + minutes. Not a cron string (nothing
 * here parses cron, and the boxes run UTC so a cron string would have to be
 * written in UTC and silently drift from what the form claims), and not
 * minutes-past-midnight (the form has two number inputs; storing the shape the
 * form edits means no lossy round-trip).
 */

import { istDate, istHourMinute, previousIstDate } from "@/lib/operations/istClock";

import type { DigestSection } from "./types";

/** The address the digests were commissioned for. */
export const DEFAULT_DIGEST_RECIPIENT = "care.itarang@gmail.com";

/** At most this many addresses — the form and the API agree on the bound. */
export const MAX_RECIPIENTS = 10;

export type DigestSlot = "morning" | "evening";

/**
 * How much the mail says.
 *
 * `summary` is the figures alone. `detailed` adds, under each one, the actual
 * rows it refers to, so the mail answers "which ones?" without a click.
 * Deliberately ONE setting for both daily slots: two formats would make the
 * 09:00 and 19:00 mails non-comparable, and doubles what has to be tested for no
 * clear gain.
 */
export type DigestDetailLevel = "summary" | "detailed";

/**
 * Which sections the mail carries, keyed by the descriptor's section keys. Every
 * key defaults ON — this exists to let somebody shorten a mail they find noisy,
 * not to make them assemble one.
 *
 * Turning them ALL off is refused on save: a mail with no content is not a
 * format, it is a mail that should have been switched off. It would still claim
 * its slot and still read as a successful send on the ledger.
 */
export type DigestSections = Record<string, boolean>;

export type DigestSettings = {
  /** Master switch. Nothing is sent while this is false. */
  enabled: boolean;
  /** Who gets the mail. Lowercased, deduped, at least one, at most MAX_RECIPIENTS. */
  recipients: string[];
  /** IST wall-clock time of the slot that covers YESTERDAY. */
  morningHour: number;
  morningMinute: number;
  /** IST wall-clock time of the slot that covers TODAY SO FAR. */
  eveningHour: number;
  eveningMinute: number;
  detail: DigestDetailLevel;
  sections: DigestSections;
  /** Attach the day's rows as an .xlsx. */
  attachExcel: boolean;
};

/**
 * What a caller may PATCH. `sections` is itself partial, because the settings
 * form sends the one tick-box that changed rather than all of them, and
 * `normalizeSections` merges it over the stored value. Typing the setter with
 * the full shape would force every caller to send a complete section map, which
 * is the exact read-modify-write race the merge exists to avoid.
 */
export type DigestSettingsPatch = Partial<Omit<DigestSettings, "sections">> & {
  sections?: Partial<DigestSections>;
};

/** Every section on, which is what a kind's defaults are. */
export function allSectionsOn(sections: DigestSection[]): DigestSections {
  const out: DigestSections = {};
  for (const s of sections) out[s.key] = true;
  return out;
}

/**
 * A kind's out-of-the-box settings.
 *
 * DEFAULTS ARE ON, which is deliberately UNLIKE `kyc_auto_approval` and
 * `nbfc_request_sla`. Those ship inert because they take consequential automated
 * actions on real cases; the worst a digest can do is send an email nobody asked
 * for. They were asked for — the digests and their recipient were the request —
 * so they start working on deploy rather than waiting for somebody to find the
 * screen. Format defaults reproduce the plainest possible mail: summary, every
 * section, no attachment.
 */
export function defaultSettings(sections: DigestSection[]): DigestSettings {
  return {
    enabled: true,
    recipients: [DEFAULT_DIGEST_RECIPIENT],
    morningHour: 9,
    morningMinute: 0,
    eveningHour: 19,
    eveningMinute: 0,
    detail: "summary",
    sections: allSectionsOn(sections),
    attachExcel: false,
  };
}

function toBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Anything that is not a plausible address is dropped, and an empty result falls
 * back to `base` instead of being saved.
 *
 * A digest with no recipients is not a configuration, it is a job that runs and
 * throws its output away — it would claim its slot, count everything, and send to
 * nobody, which reads on the ledger exactly like a successful send. Refusing the
 * empty list is what keeps "the mail stopped arriving" diagnosable.
 */
export function normalizeRecipients(raw: unknown, base: string[]): string[] {
  if (raw === undefined || raw === null) return [...base];
  const list = Array.isArray(raw) ? raw : [raw];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const email = item.trim().toLowerCase();
    // Deliberately loose — the API route runs a real zod .email() first. This is
    // the last line of defence against a hand-written app_settings row, not the
    // validator.
    if (!email || !email.includes("@") || /\s/.test(email)) continue;
    seen.add(email);
    if (seen.size >= MAX_RECIPIENTS) break;
  }
  const out = Array.from(seen);
  return out.length > 0 ? out : [...base];
}

/** Unknown values fall back rather than storing a level the renderer can't read. */
export function normalizeDetailLevel(
  raw: unknown,
  base: DigestDetailLevel,
): DigestDetailLevel {
  return raw === "summary" || raw === "detailed" ? raw : base;
}

/**
 * Merge a partial section patch over the current one, bounded to the keys this
 * kind actually has.
 *
 * Keys the descriptor does not declare are DISCARDED — a stored section for a
 * row that no longer exists would be a setting with no effect, and worse, it
 * would keep an all-off set looking non-empty. All-off is refused, falling back
 * to `base`.
 */
export function normalizeSections(
  raw: unknown,
  base: DigestSections,
  sections: DigestSection[],
): DigestSections {
  const known = sections.map((s) => s.key);
  const patch = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const out: DigestSections = {};
  for (const key of known) {
    const v = patch[key];
    out[key] = typeof v === "boolean" ? v : (base[key] ?? true);
  }

  return known.some((k) => out[k]) ? out : { ...base };
}

/**
 * Normalise whatever is in the jsonb column into a complete settings object.
 * Exported so the API route can validate a PUT body through the same funnel the
 * reader uses — one place decides what a valid setting is.
 */
export function normalizeSettings(
  raw: unknown,
  sections: DigestSection[],
  base: DigestSettings = defaultSettings(sections),
): DigestSettings {
  const patch = (raw && typeof raw === "object" ? raw : {}) as Partial<
    Record<keyof DigestSettings, unknown>
  >;

  return {
    enabled: toBool(patch.enabled, base.enabled),
    recipients: normalizeRecipients(patch.recipients, base.recipients),
    morningHour: clampInt(patch.morningHour ?? base.morningHour, 0, 23, base.morningHour),
    morningMinute: clampInt(
      patch.morningMinute ?? base.morningMinute,
      0,
      59,
      base.morningMinute,
    ),
    eveningHour: clampInt(patch.eveningHour ?? base.eveningHour, 0, 23, base.eveningHour),
    eveningMinute: clampInt(
      patch.eveningMinute ?? base.eveningMinute,
      0,
      59,
      base.eveningMinute,
    ),
    detail: normalizeDetailLevel(patch.detail, base.detail),
    sections: normalizeSections(patch.sections, base.sections, sections),
    attachExcel: toBool(patch.attachExcel, base.attachExcel),
  };
}

export type DueSlot = {
  slot: DigestSlot;
  /** The IST day the mail covers — half of the claim key. */
  digestDate: string;
};

/**
 * Which slots are due right now. PURE — no I/O, no `Date.now()` — so it is unit
 * tested directly.
 *
 * A slot is due from its configured IST time until the END of that IST day, not
 * only in the minute it strikes. The ticker runs every five minutes and a PM2 box
 * that was restarting at 09:00 would otherwise skip the morning digest entirely;
 * with a window, it sends at 09:20 when it comes back. Double-sending is
 * prevented by the (kind, digest_date, slot) claim in the database, NOT by the
 * narrowness of this window — see E-288's migration header.
 *
 * Both slots can be returned by one call. That happens on a box that has been
 * down since before 09:00 and boots at 20:00: it owes both the morning and the
 * evening digest, and each is a distinct claim.
 *
 * `morning` covers YESTERDAY; `evening` covers TODAY SO FAR.
 */
export function slotsDueAt(now: Date, s: DigestSettings): DueSlot[] {
  if (!s.enabled) return [];

  const { hour, minute } = istHourMinute(now);
  const nowMinutes = hour * 60 + minute;

  const due: DueSlot[] = [];

  if (nowMinutes >= s.morningHour * 60 + s.morningMinute) {
    due.push({ slot: "morning", digestDate: previousIstDate(now) });
  }

  if (nowMinutes >= s.eveningHour * 60 + s.eveningMinute) {
    due.push({ slot: "evening", digestDate: istDate(now) });
  }

  return due;
}

/** The IST day a slot covers, for a manual or forced send of that slot. */
export function digestDateForSlot(slot: DigestSlot, now: Date = new Date()): string {
  return slot === "morning" ? previousIstDate(now) : istDate(now);
}

/** "09:00" — how the form and the mail both render a configured time. */
export function formatSlotTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
