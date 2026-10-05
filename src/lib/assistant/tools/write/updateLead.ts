// update_lead — fill in a lead's profile from what the rep said or a document
// they sent (visiting card, shop board, GST certificate): shop name, area, city,
// state, pincode, email, GSTIN. PROPOSES only; the card shows every change as
// "old → new" and warns when a filled field would be replaced. On Confirm the
// applier writes dealer_leads the way PATCH /api/dealer-leads/[id] does (same
// region canonicalisation, src/lib/leads/regionFields.ts), inside the
// executor's transaction — whose app.actor_id makes the E-304 trigger record
// every field change against this rep. Optionally files the source document.
//
// Never touches phone, owner, status or interest: each has its own guarded tool.

import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { checkCustomerGstin } from "@/lib/leads/gstin";
import { canonicalRegionUpdates } from "@/lib/leads/regionFields";
import { createPending } from "../../actions";
import type { Preview, ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";
import { AttachmentId, DOC_TYPE_LABEL, DOC_TYPES, PlannedFile, plannedFile, resolveAttachments } from "../attachments";
import { fileDocuments } from "./attachDocument";

export const PROFILE_FIELDS = ["shop_name", "area", "city", "state", "pincode", "contact_email", "gstin"] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];

const LABEL: Record<ProfileField, string> = {
    shop_name: "Shop",
    area: "Area",
    city: "City",
    state: "State",
    pincode: "Pincode",
    contact_email: "Email",
    gstin: "GSTIN",
};

/** ID 62: what to ask when a dealer's GSTIN fails the shared check; null when it passes. */
export function gstinQuestion(gstin: string): string | null {
    const c = checkCustomerGstin(gstin);
    if (c === "ok") return null;
    if (c === "own_gstin") return "That is iTarang's own GSTIN. What is the dealer's GSTIN?";
    if (c === "bad_check_digit") return "That GSTIN's last character doesn't match the rest — one character is probably mistyped. What is it?";
    return "That GSTIN doesn't look right (15 characters, like 27ABCDE1234F1Z0). What is it?";
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PIN_RE = /^[1-9]\d{5}$/;

export const UpdateLeadPlan = z.object({
    lead_id: z.string().min(1),
    set: z.object(Object.fromEntries(PROFILE_FIELDS.map((f) => [f, z.string().nullable().optional()])) as Record<ProfileField, z.ZodOptional<z.ZodNullable<z.ZodString>>>),
    /** The legacy region column, backfilled from the city only when empty (regionFields). */
    location: z.string().nullable().optional(),
    source: PlannedFile.nullable(),
    source_doc_type: z.enum(DOC_TYPES).nullable(),
});
export type UpdateLeadPlan = z.infer<typeof UpdateLeadPlan>;

const opt = (max: number) => z.string().trim().min(1).max(max).optional();
const ask = (question: string): ToolResult => ({ kind: "question", question });
const same = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

export const updateLead: ToolFactory = () =>
    defineTool({
        name: "update_lead",
        kind: "write",
        description:
            "Propose filling in or correcting a lead's details on a lead the user owns: shop name, area, city, state, " +
            "pincode, email, GSTIN — from what the user said or from read_document. Pass only the fields to change. " +
            "Optionally also save the source photo / PDF on the lead (source_attachment_id + source_doc_type). " +
            "Phone, owner, status and temperature are NOT changed here. Nothing is saved until Confirm.",
        schema: z.object({
            lead_id: LeadId,
            shop_name: opt(200),
            area: opt(120),
            city: opt(120),
            state: opt(120),
            pincode: opt(10),
            email: opt(120),
            gstin: opt(20),
            source_attachment_id: AttachmentId.optional(),
            source_doc_type: z.enum(DOC_TYPES).optional(),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const owned = await ownedLeadOr(ctx, input.lead_id);
            if (owned.result) return owned.result;
            const lead = owned.lead;

            const gstin = input.gstin?.toUpperCase().replace(/[\s-]/g, "");
            const gstinAsk = gstin ? gstinQuestion(gstin) : null;
            if (gstinAsk) return ask(gstinAsk);
            const email = input.email?.toLowerCase();
            if (email && !EMAIL_RE.test(email)) return ask("That email address doesn't look right. What is it?");
            const pincode = input.pincode?.replace(/\s/g, "");
            if (pincode && !PIN_RE.test(pincode)) return ask("A pincode has 6 digits. What is it?");

            const [cur] = await db
                .select({
                    shop_name: dealerLeads.shop_name,
                    area: dealerLeads.area,
                    city: dealerLeads.city,
                    state: dealerLeads.state,
                    pincode: dealerLeads.pincode,
                    contact_email: dealerLeads.contact_email,
                    gstin: dealerLeads.gstin,
                    location: dealerLeads.location,
                })
                .from(dealerLeads)
                .where(eq(dealerLeads.id, lead.id))
                .limit(1);
            if (!cur) return { kind: "not_found" };

            const region = canonicalRegionUpdates({ city: input.city, state: input.state }, cur.location);
            const wanted: Partial<Record<ProfileField, string | null>> = {
                ...(input.shop_name !== undefined ? { shop_name: input.shop_name } : {}),
                ...(input.area !== undefined ? { area: input.area } : {}),
                ...(region.city !== undefined ? { city: region.city ?? input.city ?? null } : {}),
                ...(region.state !== undefined ? { state: region.state ?? input.state ?? null } : {}),
                ...(pincode !== undefined ? { pincode } : {}),
                ...(email !== undefined ? { contact_email: email } : {}),
                ...(gstin !== undefined ? { gstin } : {}),
            };
            // Read off a document, a value only FILLS an empty field: a certificate
            // that disagrees with the lead (often the wrong dealer's) must not
            // quietly move the lead to another city. The rep can still type a
            // correction without a document, shown as old → new.
            const fromDocument = !!input.source_attachment_id;
            const set: UpdateLeadPlan["set"] = {};
            const lines: Preview["lines"] = [];
            const replaced: string[] = [];
            const kept: string[] = [];
            for (const f of PROFILE_FIELDS) {
                const v = wanted[f];
                if (v === undefined || v === null || same(v, cur[f])) continue;
                const had = cur[f]?.trim();
                if (had && fromDocument) {
                    kept.push(`${LABEL[f]} ${had} (document says ${v})`);
                    continue;
                }
                set[f] = v;
                if (had) replaced.push(LABEL[f]);
                lines.push({ label: LABEL[f], value: had ? `${had} → ${v}` : `${v} (new)` });
            }

            let source: UpdateLeadPlan["source"] = null;
            let sourceType: UpdateLeadPlan["source_doc_type"] = null;
            if (input.source_attachment_id) {
                const found = await resolveAttachments(ctx, [input.source_attachment_id], { kinds: ["image", "document"], forWrite: true });
                if (found.result) return found.result;
                source = plannedFile(found.rows[0]);
                sourceType = input.source_doc_type ?? "other";
                lines.push({ label: "📎 Save", value: `${DOC_TYPE_LABEL[sourceType]} on the lead` });
            }
            if (Object.keys(set).length === 0) {
                if (!source) return { kind: "declined", reason: "Those details are already on the lead, so there is nothing to change." };
            }

            const plan: UpdateLeadPlan = {
                lead_id: lead.id,
                set,
                // Only when the city actually changes (regionFields backfills an EMPTY location from it).
                location: set.city !== undefined && region.location !== undefined ? region.location : undefined,
                source,
                source_doc_type: sourceType,
            };
            const preview: Preview = {
                title: `✏️ Update ${lead.shop_name || lead.dealer_name || lead.id}`,
                lines,
                resets_idle_clock: false,
                warning:
                    [
                        replaced.length ? `Replaces what the lead has now: ${replaced.join(", ")}.` : "",
                        kept.length ? `Kept what the lead has: ${kept.join("; ")} — check this is the right dealer's document.` : "",
                    ]
                        .filter(Boolean)
                        .join(" ") || null,
                needs_second_confirm: false,
                crm_url: leadUrl(ctx.user, lead.id),
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "update_lead",
                leadId: lead.id,
                leadVersion: lead.updated_at,
                plan,
                preview,
                before: Object.fromEntries(Object.keys(set).map((k) => [k, cur[k as ProfileField]])),
                sourceMessageId: ctx.messageId,
            });
            return { kind: "preview", action_id: id, preview };
        },
    });

export const updateLeadApplier = defineApplier<UpdateLeadPlan>({
    schema: UpdateLeadPlan,
    apply: async ({ tx, user, actionId }, p) => {
        const set = Object.fromEntries(Object.entries(p.set).filter(([, v]) => v !== undefined));
        if (Object.keys(set).length > 0) {
            await tx
                .update(dealerLeads)
                .set({ ...set, ...(p.location !== undefined ? { location: p.location } : {}), updated_at: new Date() })
                .where(eq(dealerLeads.id, p.lead_id));
        }
        const documentIds = p.source
            ? await fileDocuments(tx, {
                  leadId: p.lead_id,
                  docType: p.source_doc_type ?? "other",
                  files: [p.source],
                  note: null,
                  userId: user.id,
                  actionId,
              })
            : [];
        return { updated_fields: Object.keys(set), document_ids: documentIds };
    },
});
