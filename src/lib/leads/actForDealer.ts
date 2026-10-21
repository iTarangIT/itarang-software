// ID 183 (decided 14 Oct, sharpened 16 Oct) — iTarang acts for the dealer on a
// customer file. Pure rules only (no db import) so they can be unit-tested and
// shared by the routes, the CRM "Act for dealer" panel and the house login.
//
//   Who:    Admin and Sales Head, from the CRM file screen (ACT_FOR_DEALER_ROLES).
//           The iTarang house logins work files the house pushed out in the
//           dealer portal like the dealer (16 Oct evening) — leadActorVerdict.
//   When:   a file iTarang pushed from the house — any time; the dealer's own
//           file — only after the dealer has done nothing for 1 working day,
//           or while the dealer has asked iTarang to help.
//   Never:  dispatch from the CRM panel. Step 5 (stock, the customer's OTP,
//           dispatch), the cash sale and "delivered" stay with the dealer — and
//           the house login on a file it pushed out (recorded, 21 Oct).
//   Clash:  the file shows "being worked by <name>" for 30 minutes; a second
//           iTarang person is refused while that is live; the dealer's own
//           action always wins (it clears the note, and an iTarang save made on
//           a copy older than the dealer's last action is refused); one live
//           consent OTP at a time.
//   Record: every step is written as "Done by <name> for <dealer>" and the
//           dealer is told (bell + WhatsApp) — from the CRM panel and, since
//           21 Oct, from the house login in the dealer portal too (Step 5,
//           cash sale, delivered, customer edits, drafts, consent form,
//           coupon, product photo). The dealer sees "being worked by" on his
//           own screens, and the lines are on the file's general history.

import { workingDaysDueAt } from "@/lib/calendar/officeCalendar";

export const ACT_FOR_DEALER_ROLES = ["admin", "sales_head"] as const;

export function isActForDealerRole(role: string | null | undefined): boolean {
  return (ACT_FOR_DEALER_ROLES as readonly string[]).includes((role ?? "").toLowerCase());
}

/** How long "being worked by <name>" holds the file after an iTarang action. */
export const WORK_LOCK_MINUTES = 30;

/** Working days with no dealer action before iTarang may act on a dealer's own file. */
export const DEALER_IDLE_WORKING_DAYS = 1;

/** The audit action written for every step iTarang takes for the dealer. */
export const ACTED_FOR_DEALER = "ACTED_FOR_DEALER";

/**
 * Who is acting on a file:
 *   dealer  — the dealer the file belongs to (its owner)
 *   house   — an iTarang house login on a file the house pushed out (reads only)
 *   itarang — Admin / Sales Head from the CRM "Act for dealer" panel
 */
export type LeadActorKind = "dealer" | "house" | "itarang";

export function isItarangActor(kind: LeadActorKind): boolean {
  return kind !== "dealer";
}

export type ActGround = "house_pushed" | "dealer_asked" | "dealer_idle";

export type ActPermission = { ok: true; ground: ActGround } | { ok: false; message: string };

export const DEALER_ACTIVE_MESSAGE =
  "The dealer worked on this file within the last working day. iTarang can act for the dealer once 1 working day passes with no dealer action, or when the dealer asks for help.";

/**
 * May iTarang act for the dealer on this file now?
 *  - a file the house pushed out: always;
 *  - the dealer asked for help (open "Ask iTarang to help"): yes;
 *  - else only when 1 working day has passed with no dealer action — the
 *    same "a limit of N working days is passed from the start of working day
 *    N + 1" rule as every other time limit (officeCalendar.workingDaysDueAt).
 *    A file the dealer never touched (no known action) counts as idle.
 */
export function actForDealerPermission(input: {
  housePushed: boolean;
  dealerAsked: boolean;
  lastDealerActionAt: Date | null;
  now: Date;
  holidays: ReadonlySet<string>;
}): ActPermission {
  if (input.housePushed) return { ok: true, ground: "house_pushed" };
  if (input.dealerAsked) return { ok: true, ground: "dealer_asked" };
  if (!input.lastDealerActionAt) return { ok: true, ground: "dealer_idle" };
  const due = workingDaysDueAt(input.lastDealerActionAt, DEALER_IDLE_WORKING_DAYS, input.holidays);
  if (due && input.now.getTime() > due.getTime()) return { ok: true, ground: "dealer_idle" };
  return { ok: false, message: DEALER_ACTIVE_MESSAGE };
}

export interface WorkLock {
  holderUserId: string | null;
  holderName: string | null;
  expiresAt: Date | null;
}

/** Is someone from iTarang holding the file right now? */
export function isLockLive(lock: WorkLock | null | undefined, now: Date): boolean {
  return !!lock?.holderUserId && !!lock.expiresAt && lock.expiresAt.getTime() > now.getTime();
}

export type LockVerdict =
  | { ok: true; action: "clear" | "acquire" | "refresh" }
  | { ok: false; message: string };

function hhmm(at: Date): string {
  return at.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
}

export function beingWorkedMessage(name: string | null | undefined, until: Date): string {
  return `This file is being worked by ${(name ?? "").trim() || "someone from iTarang"} until ${hhmm(until)}. Try again after that, or ask them.`;
}

/**
 * The 30-minute "being worked by <name>" note.
 *  - the dealer always passes and clears it (the dealer's action wins);
 *  - an iTarang actor passes when nobody holds the file, the note ran out, or
 *    it is their own note (refresh); else refused with who and until when.
 */
export function lockVerdict(input: {
  lock: WorkLock | null | undefined;
  actorUserId: string;
  actorKind: LeadActorKind;
  now: Date;
}): LockVerdict {
  if (input.actorKind === "dealer") return { ok: true, action: "clear" };
  const lock = input.lock;
  if (!isLockLive(lock, input.now)) return { ok: true, action: "acquire" };
  if (lock!.holderUserId === input.actorUserId) return { ok: true, action: "refresh" };
  return { ok: false, message: beingWorkedMessage(lock!.holderName, lock!.expiresAt!) };
}

export const DEALER_CHANGED_MESSAGE =
  "The dealer worked on this file after you opened it. Reload to see their changes, then try again.";

/**
 * Dealer wins a clash: an iTarang save made on a copy the panel loaded BEFORE
 * the dealer's latest action is refused. `seen` is what the panel saw as the
 * dealer's last action when it loaded (absent = the caller does not track it,
 * e.g. an admin review screen — no check). A second's slack for clock rounding.
 */
export function dealerChangedSince(
  lastDealerActionAt: Date | null,
  seen: Date | null | undefined,
): boolean {
  if (!lastDealerActionAt || seen === undefined) return false;
  if (seen === null) return true; // the panel saw no dealer action; there is one now
  return lastDealerActionAt.getTime() - seen.getTime() > 1000;
}

/** Parse the panel's "x-seen-dealer-action-at" header: undefined = not sent. */
export function parseSeenHeader(raw: string | null | undefined): Date | null | undefined {
  if (raw === null || raw === undefined) return undefined;
  const t = raw.trim();
  if (!t || t === "none") return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}

export const SEEN_DEALER_ACTION_HEADER = "x-seen-dealer-action-at";

/**
 * One live consent OTP at a time. An iTarang person may not send a fresh OTP
 * while one someone else sent is still live (the customer would get two
 * codes). The dealer is never blocked (dealer wins). Their own live code may
 * be resent. Returns the refusal, or null.
 */
export function consentOtpResendBlocked(input: {
  live: { requestedBy: string | null; requestedByName: string | null; expiresAt: Date } | null;
  requesterId: string | null;
  requesterIsItarang: boolean;
  now: Date;
}): string | null {
  if (!input.requesterIsItarang || !input.live) return null;
  if (input.live.expiresAt.getTime() <= input.now.getTime()) return null;
  if (input.live.requestedBy && input.live.requestedBy === input.requesterId) return null;
  const who = (input.live.requestedByName ?? "").trim() || "someone else";
  return `A consent code sent by ${who} is still live until ${hhmm(input.live.expiresAt)}. Only one consent code at a time — wait for it to run out, or let the customer use it.`;
}

/** The history line every iTarang step writes. */
export function doneByLine(byName: string | null | undefined, dealerName: string | null | undefined): string {
  return `Done by ${(byName ?? "").trim() || "iTarang"} for ${(dealerName ?? "").trim() || "the dealer"}`;
}

/**
 * 21 Oct (ID 183): what recordActorStep writes for one iTarang step.
 *  - every step writes its "Done by" line, except a step marked `coalesce`
 *    (the KYC / co-borrower draft autosaves fire every few seconds) that the
 *    same person already recorded on this file within the 30-minute hold —
 *    one line per autosaving session, not one per keystroke;
 *  - the dealer is told at most once per person per file per 30 minutes
 *    (`anyRecent` = this person already recorded a step on this file then).
 */
export function recordPlan(input: { coalesce: boolean; sameStepRecent: boolean; anyRecent: boolean }): {
  write: boolean;
  notify: boolean;
} {
  if (input.coalesce && input.sameStepRecent) return { write: false, notify: false };
  return { write: true, notify: !input.anyRecent };
}

/**
 * 21 Oct (ID 183): the "being worked by <name>" line the DEALER's own screens
 * show (before, only the CRM panel did). Null when nobody from iTarang holds
 * the file. The holder sees "You are working this file until …".
 */
export function workNoteText(
  lock: WorkLock | null | undefined,
  viewer: { userId: string | null; kind: LeadActorKind },
  now: Date,
): string | null {
  if (!isLockLive(lock, now)) return null;
  if (viewer.userId && lock!.holderUserId === viewer.userId) return `You are working this file until ${hhmm(lock!.expiresAt!)}.`;
  // Another iTarang person (e.g. the house login while Admin holds the file): their saves are refused.
  if (viewer.kind !== "dealer") return beingWorkedMessage(lock!.holderName, lock!.expiresAt!);
  const who = (lock!.holderName ?? "").trim() || "someone from iTarang";
  return `Being worked by ${who} (iTarang) until ${hhmm(lock!.expiresAt!)}. The file is still yours — anything you do wins.`;
}

/**
 * 21 Oct (ID 183): one "Done by" line as the lead's general history shows it
 * ("Done by Ravi for ABC Motors: sent the consent code to the customer").
 */
export function doneByHistoryText(row: { line: string; step: string | null }): string {
  return row.step ? `${row.line}: ${row.step}` : row.line;
}

/**
 * Merge "Done by" rows into a timeline, oldest first. Each side carries its
 * instant; rows with no valid time sort first. Pure, so the history card's
 * order is testable.
 */
export function mergeTimeline<T>(entries: Array<{ at: Date | null; item: T }>): T[] {
  const t = (d: Date | null) => (d && Number.isFinite(d.getTime()) ? d.getTime() : -Infinity);
  return entries
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => t(a.at) - t(b.at) || a.i - b.i)
    .map((e) => e.item);
}

/**
 * 21 Oct (ID 183, item 5): the house login works a pushed file in the dealer
 * portal, not the CRM panel — so the dealer portal sends the same
 * "x-seen-dealer-action-at" header on the house login's saves. Which requests
 * carry it: a non-GET call to one of this file's step routes.
 */
export function carriesSeenHeader(url: string, method: string | null | undefined, leadId: string): boolean {
  if (!leadId || (method ?? "GET").toUpperCase() === "GET") return false;
  let path = url;
  try {
    path = new URL(url, "http://x").pathname;
  } catch {
    /* keep the raw string */
  }
  const id = encodeURIComponent(leadId);
  return [`/api/kyc/${id}`, `/api/lead/${id}`, `/api/coborrower/${id}`, `/api/dealer/leads/${id}`].some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
}

/**
 * The steps iTarang never takes for a dealer (decided 14 Oct, "never
 * dispatch"): they move the dealer's stock or need the customer's dispatch OTP.
 * Kept here so the routes and the panel name the same list. Applies to Admin /
 * Sales Head (the CRM panel). The house login on a file it pushed out may take
 * them (16 Oct evening, user) — recorded "Done by" and the dealer told (21 Oct).
 */
export const DEALER_ONLY_STEPS = [
  "step-5/product-selection",
  "step-5/send-otp",
  "step-5/verify-otp",
  "step-5/confirm-dispatch",
  "confirm-cash-sale",
  "mark-delivered",
] as const;

export const DEALER_ONLY_MESSAGE =
  "Only the dealer can do this step (it uses the dealer's stock and the customer's dispatch code).";

/**
 * 16 Oct (ID 183): the house login keeps SEEING a file it pushed to a dealer
 * (Pushed files), but no longer changes it — the dealer is the only owner.
 */
export const HOUSE_READ_ONLY_MESSAGE =
  "This file is with the dealer now. Only the dealer, or Admin / Sales Head through \"Act for dealer\" in the CRM, can change it. You can still see it on Pushed files.";

export const WRITE_REFUSED_MESSAGE =
  "Only the file's dealer, or Admin / Sales Head acting for the dealer, can change this file.";

export type LeadActorVerdict =
  | { ok: true; kind: LeadActorKind }
  | { ok: false; status: 403; message: string };

/**
 * Who may take a step on a customer file (ID 183, decided 16 Oct):
 *  - the file's own dealer: everything, dispatch included;
 *  - a house login on a file the house pushed to another dealer: everything,
 *    dispatch included (16 Oct evening, user — full access like the dealer);
 *  - Admin / Sales Head: reads, and writes through the act-for-dealer checks
 *    (permission, note, record, notice) — never dispatch;
 *  - anyone else (CEO, other back-office roles, other dealers): refused for
 *    writes; reads are not decided here (requireLeadAccess).
 * `houseOnPushedFile` = the caller is a house login AND the house pushed
 * this file out (houseMayActOnLead).
 */
export function leadActorVerdict(input: {
  role: string | null | undefined;
  ownsFile: boolean;
  houseOnPushedFile: boolean;
  write: boolean;
  dispatch: boolean;
}): LeadActorVerdict {
  const role = (input.role ?? "").toLowerCase();
  if (role === "dealer") {
    if (input.ownsFile) return { ok: true, kind: "dealer" };
    if (!input.houseOnPushedFile) return { ok: false, status: 403, message: "Access denied" };
    // 16 Oct evening (user): the house keeps FULL access on a file it pushed
    // out — every step, Step 5 included, like the file's dealer. Its writes
    // still take the note, the "dealer changed" check and the "Done by" record.
    return { ok: true, kind: "house" };
  }
  if (isActForDealerRole(role)) {
    if (input.dispatch) return { ok: false, status: 403, message: DEALER_ONLY_MESSAGE };
    return { ok: true, kind: "itarang" };
  }
  return {
    ok: false,
    status: 403,
    message: input.write ? WRITE_REFUSED_MESSAGE : "Only Admin or Sales Head can act for the dealer on this file.",
  };
}
