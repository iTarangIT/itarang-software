// create_lead — add a new dealer lead (the Inside Sales "New lead" form).
// PROPOSES only. Where it lands is the screen's rule: an ISR's lead goes to the
// unassigned claim pool, an ASM's is owned by them. A phone that already exists
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
            "Propose creating a NEW dealer lead. Needs the dealer's name and 10-digit mobile number; shop name, city, state, " +
            "interest level, language and business type are optional — only what the user said. Nothing is saved until Confirm.",
        schema: z.object({
            dealer_name: z.string().trim().min(2).max(200),
            phone: z.string().trim().min(10).max(20).describe("The dealer's mobile number as the user gave it"),
            shop_name: opt(200),
            city: opt(120),
            state: opt(120),
            interest_level: z.enum(INTEREST).optional(),
            language: opt(40),
            business_type: z.enum(BUSINESS_TYPES).optional(),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            if (!ctx.writesEnabled) return WRITES_OFF;
            const phone = tenDigitPhone(input.phone);
            if (!phone) return ask("That number doesn't look like a 10-digit mobile number. What is the dealer's number?");

            const existingId = await findLeadIdByPhone(phone);
            if (existingId) {
                const visible = await findLeadInScope(ctx.user, existingId);
                return {
                    kind: "declined",
                    reason: visible
                        ? `A lead with this number already exists: ${visible.shop_name || visible.dealer_name || visible.id}.`
                        : "A lead with this number already exists.",
                    crm_url: visible ? leadUrl(ctx.user, visible.id) : null,
                };
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
    apply: async ({ tx, user }, p) => {
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
                },
                { tx },
            );
            return {
                lead_id: created.id,
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
