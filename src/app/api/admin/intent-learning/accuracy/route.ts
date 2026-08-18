// GET /api/admin/intent-learning/accuracy — the report card.
//
// The in-app replacement for `npm run eval:intent`, which wrote an HTML file to
// docs/ and could therefore only be read by someone with a terminal and a
// checkout. The people who actually know whether the scoring is any good are
// the reviewers, and they had no way to see whether their corrections were
// moving the number.
//
// Everything here is computed in SQL over intent_score_feedback. It measures
// AGREEMENT (how often a human left the AI's band alone), not truth — there is
// no ground truth beyond what reviewers say, and the honest framing matters:
// a rising number means the model and the reviewers are converging, which is
// only progress if the reviewers are right.

import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { INTENT_CURATOR_ROLES } from "@/lib/leads/access";

function rowsOf<T>(result: unknown): T[] {
  return (((result as { rows?: T[] }).rows ?? (result as T[])) || []) as T[];
}

export const GET = withErrorHandler(async (req: NextRequest) => {
  await requireRole([...INTENT_CURATOR_ROLES]);

  const days = Number(new URL(req.url).searchParams.get("days") || "") || 90;

  // Only review_kind='correction' rows carry a real human label. Imported
  // Google Sheet prose lands as 'note' and must never be counted as ground
  // truth — including it would let unparseable commentary vote on accuracy.
  //
  // `agreed IS NOT NULL` excludes corrections on calls whose AI band was never
  // recorded (a correction with nothing to compare against is not a data point
  // about the model, and counting it as a miss would understate accuracy).
  const overall = rowsOf<{
    total: string | number;
    agreed: string | number;
    applied: string | number;
  }>(
    await db.execute(sql`
      SELECT COUNT(*)::int                                    AS total,
             COUNT(*) FILTER (WHERE agreed)::int              AS agreed,
             COUNT(*) FILTER (WHERE applied_to_lead)::int     AS applied
        FROM intent_score_feedback
       WHERE review_kind = 'correction'
         AND agreed IS NOT NULL
         AND created_at > now() - (${days} || ' days')::interval
    `),
  )[0];

  // Where the model goes wrong, as a confusion pairing. "AI said Warm, human
  // said Cold" is far more actionable than a single accuracy percentage — it
  // points at a specific misreading a calibration example can fix.
  const confusion = rowsOf<{
    ai_band: string | null;
    corrected_status: string;
    n: number;
  }>(
    await db.execute(sql`
      SELECT ai_band, corrected_status, COUNT(*)::int AS n
        FROM intent_score_feedback
       WHERE review_kind = 'correction'
         AND agreed IS FALSE
         AND ai_band IS NOT NULL
         AND created_at > now() - (${days} || ' days')::interval
       GROUP BY ai_band, corrected_status
       ORDER BY n DESC
       LIMIT 20
    `),
  );

  // Who is reviewing. Not a leaderboard — it answers "is this signal coming
  // from one person's opinion or from the team", which decides how much weight
  // a promotion decision deserves.
  const reviewers = rowsOf<{ reviewer_role: string | null; n: number }>(
    await db.execute(sql`
      SELECT reviewer_role, COUNT(*)::int AS n
        FROM intent_score_feedback
       WHERE review_kind = 'correction'
         AND created_at > now() - (${days} || ' days')::interval
       GROUP BY reviewer_role
       ORDER BY n DESC
    `),
  );

  const activeExamples = rowsOf<{ n: number }>(
    await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM intent_calibration_examples WHERE active`,
    ),
  )[0];

  const total = Number(overall?.total ?? 0);
  const agreed = Number(overall?.agreed ?? 0);

  return successResponse({
    windowDays: days,
    total,
    agreed,
    disagreed: total - agreed,
    // Null rather than 0 when there is nothing to measure. A brand-new install
    // showing "0% accurate" would be a lie about the model.
    agreementRate: total > 0 ? Math.round((agreed / total) * 1000) / 10 : null,
    appliedToLead: Number(overall?.applied ?? 0),
    confusion: confusion.map((c) => ({
      aiBand: c.ai_band,
      humanStatus: c.corrected_status,
      count: Number(c.n),
    })),
    reviewers: reviewers.map((r) => ({
      role: r.reviewer_role ?? "unknown",
      count: Number(r.n),
    })),
    activeExampleCount: Number(activeExamples?.n ?? 0),
  });
});
