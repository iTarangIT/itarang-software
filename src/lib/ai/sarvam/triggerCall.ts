// Place one Sarvam Instant Outbound call for a lead.
//
// Mirrors elevenlabs/triggerCall.ts: same lead lookup, scraper-lead promotion,
// phone normalisation and 25-hour idempotency guard. Sarvam only places the
// call; the CRM's dialer keeps the queue, retries and dispositions, and the
// call-end webhook (/api/sarvam/webhook) finishes the work.
//
// POST {base}/outbounds/v1/orgs/{org_id}/workspaces/{workspace_id}/outbounds
// → { attempt_id }  (422 { detail: [...] } on a bad request)

import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { normalizeIndianPhone, phoneLookupVariants } from "@/lib/ai/phone";
import { dedupClaim } from "@/lib/queue/safeRedis";
import {
  DIAL_IDEMPOTENCY_TTL_SECONDS,
  dialIdempotencyKey,
  promoteScraperLead,
} from "@/lib/ai/dialerShared";
import { outboundUrl, readSarvamConfig, webhookUrl } from "./config";
import { buildSarvamAgentVariables, sarvamErrorText } from "./callHelpers";
import type {
  SarvamCallPayload,
  SarvamCallResponse,
  SarvamCreateOutboundRequest,
  SarvamCreateOutboundResponse,
} from "./types";

export { buildSarvamAgentVariables, SARVAM_SHOP_NAME_FALLBACK } from "./callHelpers";

export async function triggerSarvamCall(
  payload: SarvamCallPayload,
): Promise<SarvamCallResponse> {
  try {
    const cfg = readSarvamConfig();
    if (!cfg.ok) {
      console.warn("[SARVAM] not configured — call disabled. Missing:", cfg.missing.join(", "));
      return {
        success: false,
        error: `Sarvam not configured (missing ${cfg.missing.join(", ")})`,
      };
    }
    const config = cfg.config;

    const lookupVariants = phoneLookupVariants(payload.phone);
    // Dialling a captured owner / alternate number: the lead is the one asked
    // for, not whoever owns that number (same rule as the ElevenLabs trigger).
    let lead = payload.dialPhone && payload.leadId
      ? await db.query.dealerLeads.findFirst({
          where: (l, { eq }) => eq(l.id, payload.leadId),
        })
      : await db.query.dealerLeads.findFirst({
          where: (l, { inArray }) => inArray(l.phone, lookupVariants),
        });
    if (!lead) {
      lead = await promoteScraperLead(payload.phone, "sarvam");
    }
    if (!lead) {
      console.error("[SARVAM] Lead not found anywhere for phone:", payload.phone);
      return { success: false, error: "Lead not found" };
    }

    const agentVariables = buildSarvamAgentVariables(lead);
    if (!lead.shop_name?.trim()) {
      console.warn(
        `[SARVAM] shop_name empty for lead ${lead.id} — speaking "${agentVariables.shop_name}" instead`,
      );
    }

    const recipientPhone = normalizeIndianPhone(payload.dialPhone ?? lead.phone ?? payload.phone);
    if (!recipientPhone) {
      return {
        success: false,
        error: "Lead phone is invalid — expected 10 digits or +91XXXXXXXXXX format.",
      };
    }

    // Same guard as ElevenLabs: one call per (lead, phone, day), skipped for
    // scheduled calls and deliberate re-calls.
    if (!payload.scheduledAt && !payload.bypassIdempotency) {
      const { claimed } = await dedupClaim(
        dialIdempotencyKey("sarvam", lead.id, recipientPhone),
        DIAL_IDEMPOTENCY_TTL_SECONDS,
        "sarvam:outbound-idem",
      );
      if (!claimed) {
        console.warn(
          `[SARVAM] Skipping duplicate call within 25h for lead ${lead.id} (${recipientPhone})`,
        );
        return {
          success: true,
          deduped: true,
          error: "Duplicate call suppressed by idempotency key",
        };
      }
    }

    const body: SarvamCreateOutboundRequest = {
      app_config: {
        app_id: config.appId,
        app_version: config.appVersion,
        connection_config: {
          connection_id: config.connectionId,
          agent_phone_number: config.agentPhoneNumber,
        },
        agent_variables: agentVariables,
      },
      user_config: { user_phone_number: recipientPhone },
      webhook_config: {
        url: webhookUrl(config),
        metadata: { lead_id: lead.id, phone: recipientPhone },
      },
    };

    // Log without the webhook token.
    console.log("[SARVAM PAYLOAD]", {
      lead: lead.id,
      to: recipientPhone,
      app: `${config.appId}@v${config.appVersion}`,
      vars: agentVariables,
    });

    const res = await fetch(outboundUrl(config), {
      method: "POST",
      headers: {
        "X-API-Key": config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => null)) as SarvamCreateOutboundResponse | null;

    if (!res.ok || !json?.attempt_id) {
      const error = sarvamErrorText(json, res.status);
      console.error("[SARVAM] API error:", res.status, json);
      return { success: false, error };
    }

    await db
      .update(dealerLeads)
      .set({ provider: "sarvam" })
      .where(eq(dealerLeads.id, lead.id));

    console.log("[SARVAM] Queued. attempt_id:", json.attempt_id);
    return { success: true, call_id: json.attempt_id };
  } catch (err) {
    console.error("[SARVAM] triggerCall error:", err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
