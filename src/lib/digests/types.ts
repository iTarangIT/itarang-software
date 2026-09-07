/**
 * The contract every scheduled digest satisfies (E-286).
 *
 * A digest is: some numbers about an IST day, some numbers about right now, and
 * a button onto the screen where you act on them. Everything else — the twice-
 * daily schedule, the (kind, date, slot) claim that stops a double send, the
 * retry ceiling, the settings screen, the email chrome, the spreadsheet — is
 * shared and lives in this folder.
 *
 * So adding a third digest is a descriptor and a sidebar entry. It is NOT a
 * table, a ticker, a cron route or an email template.
 *
 * WHY THE COUNTS ARE A LIST AND NOT A RECORD
 *   E-285 modelled its figures as a fixed `{approved, rejected, …}` object, which
 *   worked while there was one digest. A second kind with different figures would
 *   have forced either a union type the template must switch on, or a second
 *   template. A list of {label, value} lines renders the same way whatever is in
 *   it — and it is what makes an indented sub-line ("of which automatic") a
 *   property of the data rather than a special case in the renderer.
 */

/** Registered digests. Adding one here is the first of two steps; see registry.ts. */
export type DigestKindId = "dealer_validation" | "kyc_review";

/** One figure about the covered day. */
export type ActivityLine = {
  /** Stable key — what the settings screen's section tick-box switches. */
  key: string;
  label: string;
  value: number;
  /**
   * Render as a sub-line of the row above ("of which automatic"). Purely
   * presentational; an indented line is still governed by its own section key,
   * so it can be switched off without hiding its parent.
   */
  indent?: boolean;
  /** Which detail bucket expands under this line in the `detailed` format. */
  bucket?: string;
};

/** One figure about the present moment. */
export type BacklogLine = {
  key: string;
  label: string;
  value: number;
  /**
   * Shown instead of the number when set — for figures that are not counts
   * ("oldest case waiting: 129 days"). The value still drives the Excel export
   * and the stored `counts` blob, so nothing is lost by formatting it.
   */
  display?: string;
};

/** One row in a detailed list, and one row in the spreadsheet. */
export type DigestDetailRow = {
  id: string;
  /** The headline: a company, a customer — whatever names this thing. */
  title: string;
  /** Owner / contact, where there is one. */
  subtitle: string | null;
  city: string | null;
  state: string | null;
  /** 'web' | 'whatsapp' | a dealer name — whatever the kind finds useful. */
  source: string | null;
  /** When the bucket's defining event happened, ISO. */
  at: string | null;
};

/** Detail rows per bucket. Keys match the `bucket` on an ActivityLine. */
export type DigestDetail = Record<string, DigestDetailRow[]>;

/** What a kind reports for one IST day. */
export type DigestFigures = {
  activity: ActivityLine[];
  backlog: BacklogLine[];
};

/** A section the admin can tick off on the settings screen. */
export type DigestSection = {
  key: string;
  label: string;
  hint: string;
  /**
   * `activity` sections are rows in the day's table; `backlog` sections are rows
   * in "Still outstanding". The group decides which block a key belongs to, so
   * the renderer never has to guess from the key name.
   */
  group: "activity" | "backlog";
};

export type DigestKindDescriptor = {
  id: DigestKindId;
  /** Sidebar entry, page heading, and the email's H1. */
  label: string;
  /** One line under the heading on the settings screen. */
  description: string;
  /** `app_settings` key holding this kind's settings blob. */
  settingsKey: string;
  /** Route the settings screen lives at, for the sidebar and the contract test. */
  settingsHref: string;
  /** Where the email's button goes. */
  ctaHref: string;
  ctaLabel: string;
  /** The tick-boxes, in render order. */
  sections: DigestSection[];
  /** The figures. Must never throw — return ok:false and the send is cancelled. */
  collect(
    istDay: string,
  ): Promise<{ ok: boolean; figures: DigestFigures; error?: string }>;
  /** The rows behind the figures. May fail; the mail downgrades to a summary. */
  collectDetail(
    istDay: string,
  ): Promise<{ ok: boolean; detail: DigestDetail; error?: string }>;
};

/** Empty figures, for a failed collect. */
export const EMPTY_FIGURES: DigestFigures = { activity: [], backlog: [] };
