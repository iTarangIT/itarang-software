// create_lead — add a new dealer lead (the Inside Sales "New lead" form).
// PROPOSES only. Where it lands is the screen's rule (creationOwnership): a rep's
// and an ASM's lead is owned by them (ID 83). A phone that already exists
// is refused up front (the existing lead is named only if the user can see it)
// and again inside the transaction. On Confirm, createLeadApplier runs
// createInsideSalesLead() — the route's own writer — on the executor's
// transaction. There is no lead yet, so the applier's ownership is "none".

import { z } from "zod";
import { BUSINESS_TYPES } from "@/lib/leads/businessType";
import {
    DuplicatePhoneError,
    createInsideSalesLead,
    creationOwnership,
    findLeadIdByPhone,
} from "@/lib/inside-sales/createLead";
import { createPending } from "../../actions";
import { findLeadInScope } from "../../scope";
import type { Preview, ToolResult } from "../../types";
import { defineTool, WRITES_OFF, type ToolFactory } from "../spec";
import { leadUrl, queueUrl } from "../leads";
import { ActionRejected, defineApplier } from "../../applierSpec";
import { eq } from "drizzle-orm";
import { dealerLeads } from "@/lib/db/schema";
import { AttachmentId, DOC_TYPE_LABEL, DOC_TYPES, PlannedFile, plannedFile, resolveAttachments } from "../attachments";
import { fileDocuments } from "./attachDocument";
import { gstinQuestion } from "./updateLead";
import { LEAD_ORIGIN_LABEL, LEAD_ORIGINS, campaignRequired } from "@/lib/leads/leadSourceVocab";
import { recordReinquiry } from "@/lib/leads/leadSource";
import { findCampaignByName, listCampaigns } from "@/lib/leads/acquisitionCampaigns";

const INTEREST = ["hot", "warm", "cold"] as const;

export const CreateLeadPlan = z.object({
    dealer_name: z.string().min(2),
    phone: z.string().regex(/^\d{10}$/),
    shop_name: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    interest_level: z.enum(INTEREST).nullable(),
    language: z.string().nullable(),
    business_type: z.enum(BUSINESS_TYPES).nullable(),
    /** ID 81 — Found via. Default keeps older pending plans parseable. */
    origin: z.enum(LEAD_ORIGINS).nullable().default(null),
    /** ID 81 — acquisition campaign (required for Trade event / Digital ad). */
    campaign_id: z.string().nullable().default(null),
    campaign_name: z.string().nullable().default(null),
    /** E-311 — details read off a visiting card / GST certificate, set on the new lead in the same transaction. */
    extra: z
        .object({
            area: z.string().nullable(),
            pincode: z.string().nullable(),
            contact_email: z.string().nullable(),
            gstin: z.string().nullable(),
        })
        .nullable()
        .default(null),
    /** E-311 — the card / certificate itself, filed on the new lead. */
    source: PlannedFile.nullable().default(null),
    source_doc_type: z.enum(DOC_TYPES).nullable().default(null),
});
export type CreateLeadPlan = z.infer<typeof CreateLeadPlan>;

const ask = (question: string): ToolResult => ({ kind: "question", question });

/** "+91 98765 43210" / "098765 43210" / "9876543210" → 10 digits, else null. */
export function tenDigitPhone(raw: string): string | null {
    let d = raw.replace(/\D/g, "");
    if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
    else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    return /^\d{10}$/.test(d) ? d : null;
}

const opt = (max: number) => z.string().trim().max(max).optional();

export const createLead: ToolFactory = () =>
    defineTool({
        name: "create_lead",
        kind: "write",
        description:
            "Propose creating a NEW dealer lead. Needs the dealer's name, 10-digit mobile number, city, business type and " +
            "origin (how the dealer was found: " + LEAD_ORIGINS.join(", ") + ") — ask for any the user did not say, never guess. " +
            "A trade_event or digital_ad lead also needs campaign: the name of the event or ad campaign, as the user said it. " +
            "Shop name, state, interest level and language are optional — only what the user said. From a visiting card or " +
            "GST certificate (read_document) also area, pincode, email and GSTIN, and source_attachment_id + " +
            "source_doc_type to save the card on the new lead. Nothing is saved until Confirm.",
        schema: z.object({
            dealer_name: z.string().trim().min(2).max(200),
            phone: z.string().trim().min(10).max(20).describe("The dealer's mobile number as the user gave it"),
            shop_name: opt(200),
            city: opt(120),
            state: opt(120),
            interest_level: z.enum(INTEREST).optional(),
            language: opt(40),
            business_type: z.enum(BUSINESS_TYPES).optional(),
            origin: z.enum(LEAD_ORIGINS).optional().describe("How the dealer was found — only what the user said"),
            campaign: opt(200).describe("Acquisition campaign name (the trade event / ad) — only what the user said"),
            area: opt(120),
            pincode: opt(10),
            email: opt(120),
            gstin: opt(20),
            source_attachment_id: AttachmentId.optional(),
            source_doc_type: z.enum(DOC_TYPES).optional(),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            if (!ctx.writesEnabled) return WRITES_OFF;
            const phone = tenDigitPhone(input.phone);
            if (!phone) return ask("That number doesn't look like a 10-digit mobile number. What is the dealer's number?");
            const gstin = input.gstin?.toUpperCase().replace(/[\s-]/g, "") || null;
            const gstinAsk = gstin ? gstinQuestion(gstin) : null;
            if (gstinAsk) return ask(gstinAsk);
            const email = input.email?.toLowerCase() || null;
            if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return ask("That email address doesn't look right. What is it?");
            const pincode = input.pincode?.replace(/\s/g, "") || null;
            if (pincode && !/^[1-9]\d{5}$/.test(pincode)) return ask("A pincode has 6 digits. What is it?");
            let source: CreateLeadPlan["source"] = null;
            if (input.source_attachment_id) {
                const found = await resolveAttachments(ctx, [input.source_attachment_id], { kinds: ["image", "document"], forWrite: true });
                if (found.result) return found.result;
                source = plannedFile(found.rows[0]);
            }

            // ID 81: a known dealer the rep tries to add again is a Re-inquiry
            // on the lead we hold (findLeadIdByPhone is the shared check).
            const existingId = await findLeadIdByPhone(phone);
            if (existingId) {
                await recordReinquiry({
                    leadId: existingId,
                    door: "whatsapp_assistant",
                    actorId: ctx.user.id,
                    note: input.dealer_name.trim(),
                });
                const visible = await findLeadInScope(ctx.user, existingId);
                return {
                    kind: "declined",
                    reason: visible
                        ? `A lead with this number already exists: ${visible.shop_name || visible.dealer_name || visible.id}.` +
                          (source ? " I can save this photo / file on that lead instead (attach_document)." : "")
                        : "A lead with this number already exists.",
                    crm_url: visible ? leadUrl(ctx.user, visible.id) : null,
                };
            }

            // ID 81: required at creation — source cannot be added properly later.
            // Asked after the duplicate check: no questions about a dealer we have.
            if (!input.city) return ask("Which city is the dealer in?");
            if (!input.business_type) {
                return ask(`What type of business is it? (${BUSINESS_TYPES.map((b) => b.replace(/_/g, " ")).join(", ")})`);
            }
            if (!input.origin) {
                return ask(`How did we find this dealer? (${LEAD_ORIGINS.map((o) => LEAD_ORIGIN_LABEL[o]).join(", ")})`);
            }
            // ID 81: a Trade event / Digital ad lead needs its campaign. Only a
            // campaign that already exists — the Assistant never makes one up
            // from a typo.
            let campaign: { id: string; name: string } | null = null;
            if (input.campaign || campaignRequired(input.origin)) {
                campaign = input.campaign ? await findCampaignByName(input.campaign) : null;
                if (!campaign) {
                    const open = (await listCampaigns({ origin: input.origin, activeOnly: true, manualOnly: true }))
                        .slice(0, 8)
                        .map((c) => c.name);
                    const which = LEAD_ORIGIN_LABEL[input.origin].toLowerCase();
                    if (open.length === 0) {
                        return ask(
                            `A ${which} lead needs its campaign, and none is set up yet. ` +
                                "Add it on the Acquisition campaigns page in the CRM, then tell me its name.",
                        );
                    }
                    return ask(
                        (input.campaign
                            ? `I don't have a campaign called "${input.campaign}". `
                            : `Which campaign is this ${which} lead from? `) + `Open ones: ${open.join(", ")}.`,
                    );
                }
            }
            const plan: CreateLeadPlan = {
                dealer_name: input.dealer_name.trim(),
                phone,
                shop_name: input.shop_name || null,
                city: input.city || null,
                state: input.state || null,
                interest_level: input.interest_level ?? null,
                language: input.language || null,
                business_type: input.business_type ?? null,
                origin: input.origin ?? null,
                campaign_id: campaign?.id ?? null,
                campaign_name: campaign?.name ?? null,
                extra:
                    input.area || pincode || email || gstin
                        ? { area: input.area || null, pincode, contact_email: email, gstin }
                        : null,
                source,
                source_doc_type: source ? (input.source_doc_type ?? "visiting_card") : null,
            };
            const { selfAssigns } = creationOwnership(ctx.user.role);
            const lines: Preview["lines"] = [
                { label: "Dealer", value: plan.dealer_name },
                { label: "Phone", value: plan.phone },
            ];
            if (plan.shop_name) lines.push({ label: "Shop", value: plan.shop_name });
            const place = [plan.city, plan.state].filter(Boolean).join(", ");
            if (place) lines.push({ label: "Place", value: place });
            if (plan.interest_level) lines.push({ label: "Interest", value: plan.interest_level });
            if (plan.language) lines.push({ label: "Language", value: plan.language });
            if (plan.business_type) lines.push({ label: "Business", value: plan.business_type.replace(/_/g, " ") });
            if (plan.origin) lines.push({ label: "Found via", value: LEAD_ORIGIN_LABEL[plan.origin] });
            if (plan.campaign_name) lines.push({ label: "Campaign", value: plan.campaign_name });
            if (plan.extra?.area || plan.extra?.pincode) {
                lines.push({ label: "Area", value: [plan.extra.area, plan.extra.pincode].filter(Boolean).join(" · ") });
            }
            if (plan.extra?.contact_email) lines.push({ label: "Email", value: plan.extra.contact_email });
            if (plan.extra?.gstin) lines.push({ label: "GSTIN", value: plan.extra.gstin });
            if (plan.source) lines.push({ label: "📎 Save", value: `${DOC_TYPE_LABEL[plan.source_doc_type ?? "other"]} on the lead` });
            lines.push({
                label: "Goes to",
                value: selfAssigns ? "your queue — owned by you" : "the unassigned claim pool",
            });
            const preview: Preview = {
                title: `New lead — ${plan.shop_name || plan.dealer_name}`,
                lines,
                resets_idle_clock: false,
                warning: null,
                needs_second_confirm: false,
                crm_url: queueUrl(ctx.user),
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "create_lead",
                leadId: null,
                leadVersion: null,
                plan,
                preview,
                before: {},
                sourceMessageId: ctx.messageId,
            });
            return { kind: "preview", action_id: id, preview };
        },
    });

export const createLeadApplier = defineApplier<CreateLeadPlan>({
    schema: CreateLeadPlan,
    ownership: "none",
    apply: async ({ tx, user, actionId }, p) => {
        try {
            const created = await createInsideSalesLead(
                {
                    actor: { id: user.id, role: user.role },
                    dealerName: p.dealer_name,
                    phone: p.phone,
                    shopName: p.shop_name,
                    city: p.city,
                    state: p.state,
                    interestLevel: p.interest_level,
                    language: p.language,
                    businessType: p.business_type,
                    origin: p.origin,
                    campaignId: p.campaign_id,
                    door: "whatsapp_assistant",
                },
                { tx },
            );
            if (p.extra) {
                const extra = Object.fromEntries(Object.entries(p.extra).filter(([, v]) => v));
                if (Object.keys(extra).length) await tx.update(dealerLeads).set(extra).where(eq(dealerLeads.id, created.id));
            }
            const documentIds = p.source
                ? await fileDocuments(tx, {
                      leadId: created.id,
                      docType: p.source_doc_type ?? "visiting_card",
                      files: [p.source],
                      note: null,
                      userId: user.id,
                      actionId,
                  })
                : [];
            return {
                lead_id: created.id,
                document_ids: documentIds,
                crm_url: leadUrl(user, created.id),
                business_type_saved: created.businessTypeSaved ?? null,
                afterCommit: created.afterCommit,
            };
        } catch (err) {
            // Someone created the same number between the preview and the tap.
            if (err instanceof DuplicatePhoneError) throw new ActionRejected("duplicate_phone");
            throw err;
        }
    },
});
