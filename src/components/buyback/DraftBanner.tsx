"use client";

/**
 * "Saved, but not sent" — the drafts a dealer has left behind, and why each one
 * cannot be submitted (E-194).
 *
 * This exists because of what the first 32 requests on db-1 actually did: 24
 * died in DRAFT. Fourteen had no battery lines at all and ten had lines with
 * zero photos against a minimum of five. Three of the four dealers had never
 * landed a single request in the review queue — and to an admin that looked
 * like the queue was broken, while to the dealer it looked like the request had
 * been sent. Neither side was told the truth, which is that the request was
 * sitting in the dealer's own drafts waiting for photos.
 *
 * The reasons come from the server's submit gate verbatim, so this banner and
 * the Submit button cannot disagree about what is missing.
 */

import Link from "next/link";

import type { DealerRequestRow, DraftBlocker } from "./DealerRequestsTable";

/**
 * The blockers, most-actionable first, deduped by code.
 *
 * A ten-line request short on photos yields ten near-identical sentences; a
 * dealer needs "5 lines need photos", not the same sentence five times. NO_LINES
 * leads because a request with nothing in it can't be fixed by adding photos.
 */
const CODE_ORDER: DraftBlocker["code"][] = [
  "NO_LINES",
  "TOO_FEW_PHOTOS",
  "MISSING_SPECS",
  "MISSING_PROVENANCE",
  "QTY_SPLIT_MISMATCH",
];

const CODE_SUMMARY: Record<DraftBlocker["code"], (n: number) => string> = {
  NO_LINES: () => "No batteries added yet",
  TOO_FEW_PHOTOS: (n) => (n === 1 ? "1 battery needs more photos" : `${n} batteries need more photos`),
  MISSING_SPECS: (n) => (n === 1 ? "1 battery is missing details" : `${n} batteries are missing details`),
  MISSING_PROVENANCE: (n) =>
    n === 1 ? "1 battery is missing provenance" : `${n} batteries are missing provenance`,
  QTY_SPLIT_MISMATCH: (n) =>
    n === 1 ? "1 battery has an invalid working/dead split" : `${n} batteries have an invalid split`,
};

function summarise(blockers: DraftBlocker[]): string[] {
  const counts = new Map<DraftBlocker["code"], number>();
  for (const b of blockers) counts.set(b.code, (counts.get(b.code) ?? 0) + 1);
  return CODE_ORDER.filter((c) => counts.has(c)).map((c) => CODE_SUMMARY[c](counts.get(c)!));
}

/**
 * How many drafts to name before deferring to My Requests.
 *
 * Not decoration: one test dealer on db-1 has twenty. Listing all of them
 * would push the KPI row and the actual requests off the screen, so a banner
 * meant to unblock people would instead bury the page they came for.
 */
const MAX_LISTED = 5;

export default function DraftBanner({ drafts }: { drafts: DealerRequestRow[] }) {
  if (drafts.length === 0) return null;

  const listed = drafts.slice(0, MAX_LISTED);
  const hidden = drafts.length - listed.length;

  return (
    <div className="mb-[22px] rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-lg leading-none">
          ✏️
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13.5px] font-bold text-amber-900">
            {drafts.length === 1
              ? "You have 1 draft that hasn't been sent to iTarang"
              : `You have ${drafts.length} drafts that haven't been sent to iTarang`}
          </h2>
          <p className="mt-0.5 text-[12.5px] text-amber-800">
            Drafts are saved to your account, but iTarang can&apos;t see or price them until you
            submit.
          </p>

          <ul className="mt-3 flex flex-col gap-2">
            {listed.map((d) => {
              const reasons = summarise(d.draft_blockers ?? []);
              return (
                <li
                  key={d.request_id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-200 bg-white px-3 py-2"
                >
                  <Link
                    href={`/dealer-portal/buyback/${d.request_id}`}
                    className="text-[12.5px] font-bold text-amber-900 hover:underline"
                  >
                    {d.request_no}
                  </Link>
                  <span className="text-[12.5px] text-slate-500">
                    {reasons.length > 0 ? reasons.join(" · ") : "Nothing missing — never sent"}
                  </span>
                  {/* Reopens the draft in the intake editor. This label was a
                      lie until the resume route existed: it pointed at the
                      read-only detail page, so a dealer told "1 battery needs
                      more photos → Finish it" landed somewhere with no photo
                      box and went back to raise yet another request. */}
                  <Link
                    href={`/dealer-portal/buyback/new?request_id=${d.request_id}`}
                    className="ml-auto rounded-md border border-amber-300 px-2.5 py-1 text-[12px] font-semibold text-amber-900 hover:bg-amber-50"
                  >
                    {reasons.length > 0 ? "Finish it" : "Submit it"}
                  </Link>
                </li>
              );
            })}
          </ul>

          {hidden > 0 && (
            <Link
              href="/dealer-portal/buyback/requests"
              className="mt-2 inline-block text-[12.5px] font-semibold text-amber-900 hover:underline"
            >
              + {hidden} more draft{hidden === 1 ? "" : "s"} — see all requests →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
