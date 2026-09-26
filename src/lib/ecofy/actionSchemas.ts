// Request bodies for POST /api/ecofy/leads/[id]/actions (E-307).
//
// One zod discriminated union on `action`. Field names and rules follow
// Ecofy's API (docs/ecofy_openapi_v1.0.1.yaml); Ecofy validates again.
// `version` is the Ecofy case version the user was looking at — sent as
// If-Match so a stale screen gets a clear "changed, refresh" instead of
// silently overwriting. Uploads (documents, EPC quote PDF) are multipart and
// go through /api/ecofy/leads/[id]/documents instead.

import { z } from "zod";
import { ECOFY_CALL_OUTCOMES, ECOFY_CLOSURE_REASONS, ECOFY_RETURN_REASONS } from "./access";

const version = z.number().int().nonnegative();
const note = z.string().trim().max(2000).optional();
const reason = z.string().trim().min(3).max(2000);
const isoDateTime = z.string().datetime({ offset: true });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().min(1).max(100);
const money = z.number().nonnegative();

export const ecofyActionSchema = z.discriminatedUnion("action", [
    z
        .object({
            action: z.literal("log_activity"),
            type: z.enum(["CALL", "REMARK", "COMMENT", "FOLLOW_UP"]),
            callOutcome: z.enum(ECOFY_CALL_OUTCOMES).optional(),
            note,
            nextFollowUpAt: isoDateTime.optional(),
        })
        .refine((v) => v.type !== "CALL" || Boolean(v.callOutcome), {
            message: "A call needs an outcome",
            path: ["callOutcome"],
        })
        .refine((v) => v.type !== "FOLLOW_UP" || Boolean(v.nextFollowUpAt), {
            message: "A follow-up needs a date",
            path: ["nextFollowUpAt"],
        }),
    z
        .object({
            action: z.literal("book_appointment"),
            meetingType: z.enum(["PHONE", "VIDEO", "SITE_VISIT", "EPC_VISIT"]),
            scheduledAt: isoDateTime,
            bookingRemarks: note,
            epcPartnerId: id.optional(),
        })
        .refine((v) => v.meetingType !== "EPC_VISIT" || Boolean(v.epcPartnerId), {
            message: "An EPC visit needs an EPC partner",
            path: ["epcPartnerId"],
        }),
    z.object({
        action: z.literal("update_appointment"),
        appointmentId: id,
        op: z.enum(["RESCHEDULE", "COMPLETE", "NO_SHOW", "CANCEL"]),
        scheduledAt: isoDateTime.optional(),
        actualAt: isoDateTime.optional(),
        meetingRemarks: note,
        outcomeReason: note,
        epcFeedback: note,
    }),
    z.object({ action: z.literal("advance"), version }),
    z.object({
        action: z.literal("save_assessment"),
        method: z.enum(["MANUAL", "EPC"]),
        batteryKwh: z.number().nonnegative().optional(),
        inverterKva: z.number().nonnegative().optional(),
        solarKwp: z.number().nonnegative().optional(),
        sourceNote: z.string().trim().min(3).max(2000),
    }),
    z.object({ action: z.literal("confirm_assessment"), version, assessmentId: id }),
    z.object({ action: z.literal("request_eligibility"), financierId: id.optional() }),
    z.object({
        action: z.literal("quote_request"),
        epcPartnerId: id,
        channel: z.enum(["EMAIL", "WHATSAPP", "PHONE"]),
    }),
    z.object({
        action: z.literal("update_quote_request"),
        quoteRequestId: id,
        status: z.enum(["RECEIVED", "DECLINED"]),
    }),
    z.object({ action: z.literal("compose_offer"), quoteId: id, idempotencyKey: z.string().uuid() }),
    z.object({ action: z.literal("send_otp"), version, offerId: id, idempotencyKey: z.string().uuid() }),
    z.object({ action: z.literal("verify_otp"), challengeId: id, code: z.string().regex(/^\d{6}$/) }),
    z.object({ action: z.literal("create_installation"), epcPartnerId: id, scheduledOn: isoDate.optional() }),
    z
        .object({
            action: z.literal("update_installation"),
            installationId: id,
            status: z.enum(["SCHEDULED", "IN_PROGRESS", "INSTALLED", "COMMISSIONED", "STOPPED"]),
            onDate: isoDate.optional(),
            note,
            stopReason: note,
            acknowledgeNoSanction: z.boolean().optional(),
        })
        .refine((v) => v.status !== "STOPPED" || (v.stopReason ?? "").length >= 3, {
            message: "A stop needs a reason",
            path: ["stopReason"],
        }),
    z.object({ action: z.literal("request_withdrawal"), reason }),
    z.object({
        action: z.literal("close"),
        version,
        closureReason: z.enum(ECOFY_CLOSURE_REASONS),
        note,
    }),
    // --- Sales Head only ---
    z.object({ action: z.literal("return"), version, reasonCode: z.enum(ECOFY_RETURN_REASONS), note }),
    z.object({ action: z.literal("reopen"), version, reason }),
    z.object({ action: z.literal("route_financier"), version, financierId: id, note: reason }),
    z
        .object({
            action: z.literal("eligibility_decision"),
            eligibilityId: id,
            status: z.enum(["ELIGIBLE", "NOT_ELIGIBLE", "INFO_NEEDED"]),
            maxEligibleInr: money.optional(),
            reason: note,
        })
        .refine((v) => v.status !== "ELIGIBLE" || (v.maxEligibleInr ?? 0) > 0, {
            message: "Eligible needs the maximum amount",
            path: ["maxEligibleInr"],
        }),
    z
        .object({
            action: z.literal("financing_decision"),
            version,
            status: z.enum(["SANCTIONED", "REJECTED"]),
            sanctionedInr: money.optional(),
            downPaymentInr: money.optional(),
            tenureMonths: z.number().int().min(1).max(120).optional(),
            emiInr: money.optional(),
            lenderFileNo: z.string().trim().max(100).optional(),
            rejectionReason: note,
        })
        .refine((v) => v.status !== "SANCTIONED" || (v.sanctionedInr ?? 0) > 0, {
            message: "A sanction needs the amount",
            path: ["sanctionedInr"],
        })
        .refine((v) => v.status !== "REJECTED" || (v.rejectionReason ?? "").length >= 3, {
            message: "A rejection needs a reason",
            path: ["rejectionReason"],
        }),
    z.object({
        action: z.literal("down_payment"),
        receivedOn: isoDate,
        amountInr: money,
        reference: z.string().trim().max(200).optional(),
    }),
    z.object({
        action: z.literal("disbursement"),
        version,
        disbursedOn: isoDate,
        amountInr: money,
        reference: z.string().trim().max(200).optional(),
    }),
    z.object({ action: z.literal("withdrawal_confirm"), withdrawalId: id }),
    z.object({ action: z.literal("withdrawal_reject"), withdrawalId: id, reason }),
    z.object({ action: z.literal("withdrawal_epc_informed"), withdrawalId: id }),
    z.object({ action: z.literal("delete_document"), documentId: id, reason }),
]);

export type EcofyActionInput = z.infer<typeof ecofyActionSchema>;

/** Read-only data the lead detail screen loads per tab. */
export const ECOFY_LEAD_READS = [
    "case",
    "timeline",
    "activities",
    "appointments",
    "assessments",
    "quotes",
    "offers",
    "file",
    "decisions",
    "payment-status",
    "down-payment",
    "installation",
    "withdrawals",
    "documents",
    "reacceptance",
] as const;
export type EcofyLeadRead = (typeof ECOFY_LEAD_READS)[number];

/** Workspace-wide lookups (dropdown contents). */
export const ECOFY_LOOKUPS = [
    "closure_reason",
    "return_reason",
    "meeting_type",
    "document_type",
    "epc-partners",
    "financiers",
] as const;
export type EcofyLookup = (typeof ECOFY_LOOKUPS)[number];
