/**
 * E-216 — when the Drive expense scanner reads a file it has already recorded.
 *
 * Pure and dependency-free (no DB, no I/O) so the rule can be unit-tested, and
 * so there is exactly one place it is written down.
 *
 * WHY THIS EXISTS AT ALL
 *   `loadSeenVersions` used to treat ANY recorded row as "already processed",
 *   matching on (drive_file_id, md5_checksum). A PDF's md5 never changes, so a
 *   single bad run marked its files done for ever. On 2026-09-03 the OpenAI
 *   account ran out of credit and 33 purchase invoices were written off as
 *   `failed — "429 You have no credits remaining"`. Every scan afterwards
 *   reported "333 files, 0 new" and imported nothing, with no way to retry from
 *   the UI, and that spend simply never reached the CEO's expense figures.
 */

/**
 * Outcomes that settle a file version for good.
 *
 * `failed` and `needs_attention` are deliberately absent:
 *   failed          — the reason belongs to the API or the network, not to the
 *                     file, and says nothing about whether it can be read.
 *   needs_attention — the model read the file and returned no usable amount; a
 *                     later, healthier call may well succeed.
 * Neither produced an expense row, so retrying them cannot double-count.
 *
 * `unsupported` stays settled because it is decided from the mimetype and the
 * byte size before any model call — re-reading cannot change the answer until
 * the rules themselves change, and a new rule means new code, not a new scan.
 */
export const SETTLED_FILE_STATUSES = ["imported", "duplicate", "unsupported"] as const;

/**
 * How long a retryable file rests before the scanner tries it again.
 *
 * Without it the six-hourly ticker would re-download and re-bill every
 * permanently broken file four times a day, for ever, and a drain would never
 * converge on "nothing left to do". `drive_expense_files.updated_at` is stamped
 * by the upsert in `recordFile`, so this needs no new column.
 */
export const RETRY_COOLDOWN_MS =
  Number(process.env.DRIVE_EXPENSE_RETRY_COOLDOWN_MS || "") || 12 * 60 * 60_000;

/** One recorded file version, as the retry rule sees it. */
export interface RecordedFileVersion {
  status: string;
  /** How many expense rows this file produced. */
  expenseIdCount: number;
  /** `drive_expense_files.updated_at` — when it was last attempted. */
  lastAttemptedAt: Date | null;
}

/**
 * Should this already-recorded file version be left alone?
 *
 * `true` means "do not download, do not send to the model". Three independent
 * reasons, and all three are needed:
 *
 *  1. **A settled status** — see SETTLED_FILE_STATUSES.
 *
 *  2. **It already produced expense rows**, whatever its status says. Not
 *     redundant with (1): `importSheet` returns `needs_attention` with a
 *     NON-EMPTY id array when some rows of a costing sheet validated and others
 *     did not. Re-reading such a file would insert nothing — its rows carry a
 *     non-NULL `drive_row_ref`, so the E-216 unique index does bite — but it
 *     would rewrite the file row to `duplicate` with an empty id array, quietly
 *     dropping the un-imported lines out of the needs-attention queue.
 *
 *  3. **It is still resting** — see RETRY_COOLDOWN_MS. `ignoreCooldown` waives
 *     this for the "Retry these" button, where a person has asked explicitly
 *     and has already decided it is worth the model call. It waives ONLY the
 *     cooldown: a retry must never re-read a file that imported.
 */
export function isSettledFileVersion(
  row: RecordedFileVersion,
  opts: { now?: number; ignoreCooldown?: boolean } = {},
): boolean {
  if ((SETTLED_FILE_STATUSES as readonly string[]).includes(row.status)) return true;
  if (row.expenseIdCount > 0) return true;
  if (opts.ignoreCooldown) return false;
  if (!row.lastAttemptedAt) return false;
  const age = (opts.now ?? Date.now()) - row.lastAttemptedAt.getTime();
  return age < RETRY_COOLDOWN_MS;
}
