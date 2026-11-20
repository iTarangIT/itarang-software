/**
 * E-391 — Battery Pool diagram 1, part 2: NBFC routing rules, DB side.
 * The pure matching lives in ./nbfc-routing-rules.ts.
 *
 *   resolveRoutingTarget(leadId) — the most specific active rule for the lead,
 *     kept only when its NBFC + loan product passes the BRE for this lead
 *     (dealer blocks, location, battery category, loan amount) and the lead has
 *     not already been with that NBFC.
 *   autoRouteLead(leadId)        — when Step 4 opens, send the file to that NBFC
 *     with no lender pick: the same submitStep4ProductSelection a manual
 *     submit runs (fan-out, NBFC email, notifications). Never throws.
 *   step4OpenedFor(leadId)       — auto-route, else the usual WhatsApp
 *     "Choose lender" prompt.
 *
 * No rule / BRE says no → nothing changes: today's Step 4 choice, where the
 * older city_default_loan_products pins still narrow the list.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  auditLogs,
  leads,
  nbfcLeadAssignments,
  nbfcRoutingRules,
  productCategories,
  productSelections,
} from "@/lib/db/schema";

import { pickRoutingRule, describeRuleScope, type RoutingLead } from "./nbfc-routing-rules";
import { loadSectionGOptions } from "./section-g";

export * from "./nbfc-routing-rules";

export type RoutingRuleRow = typeof nbfcRoutingRules.$inferSelect;

export async function activeRoutingRules(): Promise<RoutingRuleRow[]> {
  try {
    return await db
      .select()
      .from(nbfcRoutingRules)
      .where(eq(nbfcRoutingRules.is_active, true))
      .orderBy(desc(nbfcRoutingRules.id));
  } catch (err) {
    // A database without E-391 has no rules.
    console.warn("[nbfc-routing] rules not readable", err instanceof Error ? err.message : String(err));
    return [];
  }
}

async function leadRow(leadId: string) {
  const [l] = await db
    .select({
      id: leads.id,
      dealer_id: leads.dealer_id,
      state: leads.state,
      city: leads.city,
      product_category_id: leads.product_category_id,
      product_type_id: leads.product_type_id,
      resident_status: leads.resident_status,
      requested_loan_amount: leads.requested_loan_amount,
      payment_method: leads.payment_method,
      kyc_status: leads.kyc_status,
      assignment_status: leads.assignment_status,
      uploader_id: leads.uploader_id,
      recalled_at: leads.recalled_at,
      resubmitted_at: leads.resubmitted_at,
      full_name: leads.full_name,
      owner_name: leads.owner_name,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  return l ?? null;
}

/** product_category_id → product_categories.name; a value that is already a name ("3W") passes through. */
async function categoryName(raw: string | null): Promise<string | null> {
  const v = (raw ?? "").trim();
  if (!v) return null;
  try {
    const [c] = await db.select({ name: productCategories.name }).from(productCategories).where(eq(productCategories.id, v)).limit(1);
    if (c?.name) return c.name;
  } catch {
    /* not a uuid — fall through */
  }
  return /^[0-9a-f-]{36}$/i.test(v) ? null : v;
}

export type RoutingTarget =
  | { ok: true; rule: RoutingRuleRow; nbfcId: number; loanProductId: number; nbfcName: string; productName: string; scope: string }
  | { ok: false; why: string; rule?: RoutingRuleRow };

/** Which NBFC a routing rule sends this lead to, after the BRE check. Read-only. */
export async function resolveRoutingTarget(leadId: string): Promise<RoutingTarget> {
  const lead = await leadRow(leadId);
  if (!lead) return { ok: false, why: "Lead not found" };
  const rules = await activeRoutingRules();
  if (!rules.length) return { ok: false, why: "No routing rules are set up" };

  const facts: RoutingLead = {
    dealer_id: lead.dealer_id,
    state: lead.state,
    city: lead.city,
    category: await categoryName(lead.product_category_id),
  };
  const rule = pickRoutingRule(rules, facts);
  if (!rule) return { ok: false, why: "No routing rule matches this lead" };

  const assigned = await db
    .select({ nbfc_id: nbfcLeadAssignments.nbfc_id })
    .from(nbfcLeadAssignments)
    .where(eq(nbfcLeadAssignments.lead_id, leadId));
  const options = await loadSectionGOptions(
    {
      dealer_id: lead.dealer_id,
      product_category_id: lead.product_category_id,
      state: lead.state,
      city: lead.city,
      resident_status: lead.resident_status,
    },
    lead.requested_loan_amount != null ? Number(lead.requested_loan_amount) : null,
    { excludeNbfcIds: assigned.map((a) => a.nbfc_id), skipPinnedDefault: true },
  );
  const nbfc = options.find((o) => o.nbfcId === rule.nbfc_id);
  const product = nbfc?.activeLoanProducts.find((p) => p.id === rule.loan_product_id);
  const scope = describeRuleScope(rule);
  if (!nbfc || !product) {
    return {
      ok: false,
      rule,
      why: `Rule #${rule.id} (${scope}) matches, but its loan product does not fit this lead (eligibility, amount, location, dealer block, or the lead was already with that NBFC)`,
    };
  }
  return {
    ok: true,
    rule,
    nbfcId: rule.nbfc_id,
    loanProductId: rule.loan_product_id,
    nbfcName: nbfc.shortName || nbfc.legalName,
    productName: product.productName,
    scope,
  };
}

export type AutoRouteResult =
  | { routed: true; nbfcName: string; productName: string; ruleId: number }
  | { routed: false; why: string };

/**
 * Send the file to the routing rule's NBFC when Step 4 opens. Idempotent (a
 * lead that already went to any lender, or whose Step 4 was submitted, is
 * left alone) and never throws.
 */
export async function autoRouteLead(leadId: string, opts: { trigger: string }): Promise<AutoRouteResult> {
  try {
    const lead = await leadRow(leadId);
    if (!lead) return { routed: false, why: "Lead not found" };
    if (String(lead.payment_method ?? "").toLowerCase() !== "finance") return { routed: false, why: "Not a finance lead" };

    const { STEP4_UNLOCKED_STATUSES, submitStep4ProductSelection } = await import("./submit-step4");
    if (!STEP4_UNLOCKED_STATUSES.has(String(lead.kyc_status))) return { routed: false, why: "Step 4 is not open" };

    const { isNbfcRoutingBlocked } = await import("./dealer-assignment-rules");
    if (isNbfcRoutingBlocked(lead.assignment_status).blocked) return { routed: false, why: "Dealer check open" };
    const { isLeadRecalled } = await import("@/lib/nbfc/recall");
    if (isLeadRecalled(lead)) return { routed: false, why: "File recalled" };

    const [anyAssignment] = await db
      .select({ id: nbfcLeadAssignments.id })
      .from(nbfcLeadAssignments)
      .where(eq(nbfcLeadAssignments.lead_id, leadId))
      .limit(1);
    if (anyAssignment) return { routed: false, why: "Already with a lender" };
    const [submitted] = await db
      .select({ id: productSelections.id })
      .from(productSelections)
      .where(and(eq(productSelections.lead_id, leadId), isNotNull(productSelections.submitted_at)))
      .limit(1);
    if (submitted) return { routed: false, why: "Step 4 already submitted" };

    const target = await resolveRoutingTarget(leadId);
    if (!target.ok) return { routed: false, why: target.why };

    const { getPreSanctionBucket } = await import("./pre-sanction-bucket");
    const { items: preSanctionDocs } = await getPreSanctionBucket(leadId).catch(() => ({ items: [] as never[] }));

    await submitStep4ProductSelection({
      leadId,
      lead: { product_category_id: lead.product_category_id, product_type_id: lead.product_type_id },
      body: {
        selectedNbfcs: [{ nbfc_id: String(target.nbfcId), loan_product_id: target.loanProductId }],
        preSanctionDocs,
        customerDisclosureAck: false,
      },
      submittedBy: lead.uploader_id ?? "",
      dealerCode: lead.dealer_id,
      // Already resolved above — don't let the submit re-resolve and override.
      routingResolved: true,
    });

    const note = `Sent to ${target.nbfcName} — ${target.productName} automatically by NBFC routing rule #${target.rule.id} (${target.scope})`;
    await db
      .insert(auditLogs)
      .values({
        id: `AUDIT-${Date.now()}-autoroute`,
        entity_type: "lead",
        entity_id: leadId,
        action: "LEAD_AUTO_ROUTED",
        changes: {
          rule_id: target.rule.id,
          scope: target.scope,
          nbfc_id: target.nbfcId,
          nbfc_name: target.nbfcName,
          loan_product_id: target.loanProductId,
          loan_product_name: target.productName,
          trigger: opts.trigger,
        },
        performed_by: null,
        timestamp: new Date(),
      })
      .catch((err) => console.warn("[nbfc-routing] audit failed", err));

    void tellDealer(leadId, target.nbfcName, lead.full_name || lead.owner_name || null, note);
    void tellSalesPeople({
      leadId,
      dealerCode: lead.dealer_id,
      customer: lead.full_name || lead.owner_name || null,
      nbfcName: target.nbfcName,
      productName: target.productName,
      ruleId: target.rule.id,
      scope: target.scope,
    });
    return { routed: true, nbfcName: target.nbfcName, productName: target.productName, ruleId: target.rule.id };
  } catch (err) {
    console.error(`[nbfc-routing] auto-route ${leadId} failed`, err);
    return { routed: false, why: err instanceof Error ? err.message : "Auto-route failed" };
  }
}

async function tellDealer(leadId: string, nbfcName: string, customer: string | null, note: string) {
  try {
    const { recordKycEvent } = await import("@/lib/kyc/kycEventLog");
    await recordKycEvent({
      leadId,
      action: note,
      actor: { id: null, name: "iTarang", role: null, type: "system", channel: "system" },
      notify: false,
    });
  } catch (err) {
    console.warn("[nbfc-routing] timeline line failed", err instanceof Error ? err.message : String(err));
  }
  try {
    const { emit, toLeadDealer } = await import("@/lib/notifications/emit");
    await emit({
      type: "lead.auto_routed",
      title: "Application sent to the lender",
      message: `${customer ?? "The customer"}'s application was sent to ${nbfcName} automatically (iTarang routing rule). We'll tell you when they respond.`,
      leadId,
      stage: "Step 4 · Lender",
      to: [toLeadDealer(leadId, { href: `/dealer-portal/leads/${leadId}/product-selection` })],
    });
  } catch (err) {
    console.warn("[nbfc-routing] dealer bell failed", err instanceof Error ? err.message : String(err));
  }
  try {
    const { pushToLead } = await import("@/lib/whatsapp/lead-push");
    // Lender names stay masked on WhatsApp, as in the Step 4 lender list.
    await pushToLead(leadId, (t) => ({
      prompt: {
        kind: "text",
        body:
          t.audience === "dealer"
            ? `✅ *${t.customerName}'s KYC is approved* and application ${t.referenceId} has been sent to the lending partner automatically. We'll message you here as soon as they respond.`
            : `✅ *Your KYC is approved* and application ${t.referenceId} has been sent to the lending partner. We'll message you here as soon as they respond.`,
      },
      nudge: {
        template: "lead_action",
        params: [t.greetName, t.referenceId, "your application has been sent to the lending partner"],
      },
    }));
  } catch (err) {
    console.warn("[nbfc-routing] WhatsApp notice failed", err instanceof Error ? err.message : String(err));
  }
}

/**
 * The iTarang sales people behind this file hear WHICH NBFC and loan product
 * the routing rule picked (they are iTarang staff, so the lender is named —
 * unlike the masked dealer / customer copy):
 *   - the dealer's account owner (Account ownership, E-321);
 *   - whoever started the file and went through the E-390 dealer check (an
 *     operator on WhatsApp, or a House team login on the CRM).
 * CRM bell for each person; WhatsApp to their operator number(s) and to the
 * number that started the KYC. Never throws.
 */
async function tellSalesPeople(p: {
  leadId: string;
  dealerCode: string | null;
  customer: string | null;
  nbfcName: string;
  productName: string;
  ruleId: number;
  scope: string;
}) {
  try {
    const { accountOwnership, leadDealerReviews, whatsappOnboardingSessions, whatsappOperators } = await import("@/lib/db/schema");
    const { inArray } = await import("drizzle-orm");

    const userIds = new Set<string>();
    const waPhones = new Set<string>();
    if (p.dealerCode) {
      const [own] = await db
        .select({ owner: accountOwnership.owner_user_id })
        .from(accountOwnership)
        .where(eq(accountOwnership.account_id, p.dealerCode))
        .limit(1);
      if (own?.owner) userIds.add(own.owner);
    }
    try {
      const reviews = await db
        .select({ uid: leadDealerReviews.initiated_by_user_id, wa: leadDealerReviews.initiator_wa_phone })
        .from(leadDealerReviews)
        .where(eq(leadDealerReviews.lead_id, p.leadId));
      for (const r of reviews) {
        if (r.uid) userIds.add(r.uid);
        if (r.wa) waPhones.add(r.wa);
      }
    } catch {
      /* DB without E-390 */
    }
    if (userIds.size) {
      const ops = await db
        .select({ wa: whatsappOperators.wa_phone })
        .from(whatsappOperators)
        .where(and(inArray(whatsappOperators.user_id, [...userIds]), eq(whatsappOperators.is_active, true)));
      for (const o of ops) if (o.wa) waPhones.add(o.wa);
    }
    if (!userIds.size && !waPhones.size) return;

    const [lr] = await db.select({ ref: leads.reference_id }).from(leads).where(eq(leads.id, p.leadId)).limit(1);
    const who = `${p.customer ?? "Customer"} (${lr?.ref ?? p.leadId})`;
    const message = `${who} was sent to ${p.nbfcName} — ${p.productName}, by NBFC routing rule #${p.ruleId} (${p.scope}).`;

    if (userIds.size) {
      const { emit } = await import("@/lib/notifications/emit");
      await emit({
        type: "lead.auto_routed",
        title: `Sent to ${p.nbfcName} — ${p.productName}`,
        message,
        leadId: p.leadId,
        stage: "Step 4 · Lender",
        to: [...userIds].map((uid) => ({
          audience: { kind: "user" as const, userId: uid },
          as: { party: "admin" as const, label: "iTarang sales" },
          href: `/admin/kyc-review/${encodeURIComponent(p.leadId)}`,
        })),
      });
    }

    if (waPhones.size) {
      const { reply } = await import("@/lib/whatsapp/session-store");
      for (const wa of waPhones) {
        const [hub] = await db
          .select()
          .from(whatsappOnboardingSessions)
          .where(and(eq(whatsappOnboardingSessions.wa_phone, wa), eq(whatsappOnboardingSessions.session_kind, "operator_hub")))
          .orderBy(desc(whatsappOnboardingSessions.updated_at))
          .limit(1);
        if (!hub) continue;
        await reply(
          hub as unknown as Parameters<typeof reply>[0],
          `🏦 *Sent to the lender*\n\n${who}\n*NBFC:* ${p.nbfcName}\n*Loan product:* ${p.productName}\n_By NBFC routing rule #${p.ruleId} (${p.scope})._`,
        ).catch((err: unknown) => console.warn("[nbfc-routing] operator WhatsApp failed", err instanceof Error ? err.message : String(err)));
      }
    }
  } catch (err) {
    console.warn("[nbfc-routing] sales-person notice failed", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Step 4 just opened for this lead (KYC approved, or the dealer check
 * approved): auto-route when a rule fits, otherwise the usual WhatsApp
 * "Choose lender" prompt. Never throws.
 */
export async function step4OpenedFor(leadId: string, trigger: string): Promise<void> {
  const r = await autoRouteLead(leadId, { trigger });
  if (r.routed) return;
  try {
    const { pushStep4ToWhatsApp } = await import("@/lib/whatsapp/step4-flow");
    await pushStep4ToWhatsApp(leadId);
  } catch (err) {
    console.warn("[nbfc-routing] Step 4 prompt failed", err instanceof Error ? err.message : String(err));
  }
}

/** For the admin screen: rules with what each points at. */
export async function listRulesForAdmin() {
  const rules = await db.select().from(nbfcRoutingRules).orderBy(desc(nbfcRoutingRules.is_active), desc(nbfcRoutingRules.id));
  return rules;
}

/** Used by the server guard in submitStep4ProductSelection. */
export async function routingOverrideFor(leadId: string): Promise<{ nbfcId: number; loanProductId: number } | null> {
  const t = await resolveRoutingTarget(leadId).catch(() => null);
  return t && t.ok ? { nbfcId: t.nbfcId, loanProductId: t.loanProductId } : null;
}

