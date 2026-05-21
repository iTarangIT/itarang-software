/**
 * E-111 — server-side loader for the latest open correction round + items.
 *
 * Returned shape is pre-mapped (labels resolved, sections assigned) so the
 * admin edit pages can pass it straight to `NbfcFlaggedItemsAlert`.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  nbfcCorrectionItems,
  nbfcCorrectionRounds,
} from "@/lib/db/schema";
import {
  type CorrectionKind,
  type CorrectionSection,
  labelFor,
  sectionFor,
} from "./correction-catalog";

export interface LoadedFlagSummary {
  roundId: number;
  roundNumber: number;
  items: Array<{
    kind: CorrectionKind;
    targetKey: string;
    label: string;
    section: CorrectionSection;
    remark: string | null;
    resolutionStatus: "pending" | "resolved" | "dismissed";
  }>;
}

export async function loadOpenRoundSummary(
  nbfcId: number,
): Promise<LoadedFlagSummary | null> {
  try {
    const [round] = await db
      .select()
      .from(nbfcCorrectionRounds)
      .where(
        and(
          eq(nbfcCorrectionRounds.nbfc_id, nbfcId),
          eq(nbfcCorrectionRounds.status, "open"),
        ),
      )
      .orderBy(desc(nbfcCorrectionRounds.round_number))
      .limit(1);
    if (!round) return null;

    const items = await db
      .select()
      .from(nbfcCorrectionItems)
      .where(eq(nbfcCorrectionItems.round_id, round.id))
      .orderBy(nbfcCorrectionItems.id);

    return {
      roundId: round.id,
      roundNumber: round.round_number,
      items: items.map((it) => {
        const kind = it.kind as CorrectionKind;
        return {
          kind,
          targetKey: it.target_key,
          label: labelFor(kind, it.target_key),
          section: sectionFor(kind),
          remark: it.remark,
          resolutionStatus: it.resolution_status as
            | "pending"
            | "resolved"
            | "dismissed",
        };
      }),
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[E-111] loadOpenRoundSummary failed — migration not applied?",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
