/**
 * Cron: the twice-daily digest emails (E-285, generalised by E-286).
 *
 * The BACKSTOP and the manual handle. The primary driver is the in-process
 * ticker in src/instrumentation-node.ts — vercel.json's crons do not fire on the
 * Hostinger PM2 boxes (docs/DEPLOY_RUNBOOK.md), so this route exists for a VPS
 * crontab line and for forcing a slot by hand while testing.
 *
 * SAFE TO RUN ALONGSIDE THE TICKER. Each send is claimed by a
 * (kind, digest_date, slot) row, so the two can only ever split work, never
 * duplicate it — the same guarantee kyc-auto-approval has.
 *
 * With no query string it runs every registered kind and sends whatever
 * `slotsDueAt()` says is owed. `?kind=` narrows to one; `?slot=` forces one —
 * still subject to the claim, so a second curl in the same day returns
 * `sent: false` rather than mailing twice.
 *
 * Auth: trusts the Vercel cron header (`x-vercel-cron`), else a
 * `Bearer CRON_SECRET`, else allows unauthenticated in non-production — matching
 * its sibling crons.
 *
 * Crontab lines for the VPS (the box runs UTC, so 09:00 / 19:00 IST are
 * 03:30 / 13:30 UTC):
 *
 *   30 3  * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     http://127.0.0.1:3002/api/cron/digest >> /var/log/itarang-cron.log 2>&1
 *   30 13 * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     http://127.0.0.1:3002/api/cron/digest >> /var/log/itarang-cron.log 2>&1
 */
import { NextRequest, NextResponse } from "next/server";

import { runAllDigests, runDigest } from "@/lib/digests/engine";
import type { DigestRunSlot } from "@/lib/digests/engine";
import { DIGEST_KIND_IDS, digestKind } from "@/lib/digests/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorised(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

function parseSlot(raw: string | null): DigestRunSlot | undefined {
  if (raw === "morning" || raw === "evening" || raw === "test") return raw;
  return undefined;
}

async function run(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  const slot = parseSlot(req.nextUrl.searchParams.get("slot"));
  const kindId = req.nextUrl.searchParams.get("kind");

  // An unknown kind is a 400, by name. Silently running every digest because a
  // crontab line has a typo in it is how you find out months later.
  if (kindId) {
    const kind = digestKind(kindId);
    if (!kind) {
      return NextResponse.json(
        { ok: false, error: `unknown kind "${kindId}"`, known: DIGEST_KIND_IDS },
        { status: 400 },
      );
    }
    const result = await runDigest({ kind, slot, triggeredBy: "cron" });
    return NextResponse.json({ ok: result.ok, outcomes: result.outcomes });
  }

  // No kind: every registered digest. A forced slot applies to all of them.
  if (slot) {
    const outcomes = [];
    let ok = true;
    for (const id of DIGEST_KIND_IDS) {
      const kind = digestKind(id)!;
      const r = await runDigest({ kind, slot, triggeredBy: "cron" });
      outcomes.push(...r.outcomes);
      ok = ok && r.ok;
    }
    return NextResponse.json({ ok, outcomes });
  }

  const result = await runAllDigests({ triggeredBy: "cron" });
  // Empty outcomes when nothing is due — the ordinary result of a crontab line
  // that fires a few minutes before the configured time.
  return NextResponse.json({ ok: result.ok, outcomes: result.outcomes });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
