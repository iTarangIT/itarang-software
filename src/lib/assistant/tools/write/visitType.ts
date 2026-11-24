// 24 Nov tree — the Type of business + Segment step that log_visit and
// set_follow_up (kind visit) share. Same rule as the visit form
// (lib/leads/visitBusinessType.ts): a type always; a Battery Sale needs at
// least one segment. What the ASM states goes on the plan and the card; what
// is missing is ASKED, never guessed.

import { z } from "zod";
import { BUSINESS_TYPES, BUSINESS_TYPE_LABELS, businessTypeLabel, type BusinessType } from "@/lib/leads/businessType";
import { LEAD_SEGMENTS, parseSegments, type LeadSegment } from "@/lib/leads/segments";
import { currentLeadType, planVisitBusinessType } from "@/lib/leads/visitBusinessType";
import type { Preview } from "../../types";

export const TYPE_QUESTION = `What is this dealer's type of business? (${Object.values(BUSINESS_TYPE_LABELS).join(", ")})`;
export const SEGMENT_QUESTION = `It's a battery sale — what does the dealer sell? Pick one or more: ${LEAD_SEGMENTS.join(", ")}.`;

/** The tool-input fields (both tools). */
export const visitTypeInputShape = {
    business_type: z
        .enum(BUSINESS_TYPES)
        .optional()
        .describe(
            "The lead's type of business — what deal it is: battery_sale, buyback, scrap or other. " +
                "Required when the lead has none yet — ask the ASM, never guess.",
        ),
    segments: z
        .array(z.string())
        .max(10)
        .optional()
        .describe(
            `What the dealer sells, one or more of: ${LEAD_SEGMENTS.join(", ")}. ` +
                "Required for a battery sale when the lead has none yet — ask, never guess.",
        ),
};

/** The plan fields (both appliers). Absent on plans stored before 24 Nov → null / []. */
export const visitTypePlanShape = {
    business_type: z.enum(BUSINESS_TYPES).nullable().default(null),
    segments: z.array(z.enum(LEAD_SEGMENTS)).default([]),
};

export type VisitTypeStep =
    | { question: string }
    | { business_type: BusinessType | null; segments: LeadSegment[]; lines: Preview["lines"] };

export async function resolveVisitType(
    leadId: string,
    input: { business_type?: string; segments?: string[] },
): Promise<VisitTypeStep> {
    const current = await currentLeadType(leadId);
    const plan = planVisitBusinessType({ business_type: input.business_type, segments: parseSegments(input.segments ?? []) }, current);
    if (!plan.ok) return { question: plan.missing === "type" ? TYPE_QUESTION : SEGMENT_QUESTION };
    const lines: Preview["lines"] = [];
    if (plan.writeType) {
        lines.push({
            label: "Business",
            value: current.business_type
                ? `${businessTypeLabel(current.business_type)} → ${businessTypeLabel(plan.writeType)}`
                : businessTypeLabel(plan.writeType),
        });
    }
    if (plan.writeSegments) lines.push({ label: "Segment", value: plan.writeSegments.join(", ") });
    return { business_type: plan.writeType, segments: plan.writeSegments ?? [], lines };
}
