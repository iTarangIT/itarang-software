/**
 * FI single-use link dispatch — BRD Addendum V0.3.1 §10.6.
 *
 * Routes the field-form link to the agent over Email / SMS / WhatsApp.
 *
 * The Coordinator may pick the channel explicitly (`input.channel`); when they
 * do we honour it and surface a clear error if the matching contact is missing
 * (no silent fallback — they asked for that wire). When no channel is given we
 * fall back to the agent's preferred channel with Email as the universal
 * fallback (v1 stance Gamma). SMS and WhatsApp both go through the shared
 * Gupshup picker (`sendKycSms`); the chosen wire is passed through per-call.
 *
 * Returns the channel actually used so the caller can record link_channel.
 * Never throws — dispatch failures are returned as { ok:false } so the
 * Coordinator sees a clear error instead of a 500.
 */
import type { FiAgent, FiChannel } from "@/lib/nbfc/fi-agents";
import { sendFiAgentLinkEmail } from "@/lib/email/sendFiAgentLinkEmail";
import { sendKycSms } from "@/lib/sms";

export interface DispatchFiLinkInput {
  agent: FiAgent;
  url: string;
  customerName: string;
  expiresAt: Date;
  /** Explicit Coordinator choice; overrides the agent's preferred channel. */
  channel?: FiChannel;
}

export interface DispatchResult {
  ok: boolean;
  channel: "email" | "sms" | "whatsapp" | null;
  error?: string;
}

export async function dispatchFiLink(input: DispatchFiLinkInput): Promise<DispatchResult> {
  const { agent, url, customerName, expiresAt } = input;
  const preferred = (agent.preferred_channel as FiChannel) || "email";

  const hasEmail = !!agent.email?.trim();
  const hasPhone = !!agent.phone?.trim();
  let channel: FiChannel;
  if (input.channel) {
    // Explicit choice — require the matching contact rather than silently
    // re-routing to a wire the Coordinator didn't pick.
    if (input.channel === "email" && !hasEmail) {
      return { ok: false, channel: "email", error: "This agent has no email on file. Add one in the FI Agent Directory or pick SMS / WhatsApp." };
    }
    if ((input.channel === "sms" || input.channel === "whatsapp") && !hasPhone) {
      return { ok: false, channel: input.channel, error: "This agent has no phone on file. Add one in the FI Agent Directory or pick Email." };
    }
    channel = input.channel;
  } else if (preferred === "email" && hasEmail) channel = "email";
  else if ((preferred === "sms" || preferred === "whatsapp") && hasPhone) channel = preferred;
  else if (hasEmail) channel = "email";
  else if (hasPhone) channel = "sms";
  else return { ok: false, channel: null, error: "Agent has neither email nor phone on file." };

  try {
    if (channel === "email") {
      await sendFiAgentLinkEmail({
        toEmail: agent.email!.trim(),
        agentName: agent.name,
        customerName,
        city: agent.city,
        url,
        expiresAt,
      });
      return { ok: true, channel };
    }
    // SMS / WhatsApp — pass the chosen wire through to Gupshup.
    const msg = `iTarang: field verification visit for ${customerName}. Open on your phone at the address (expires ${expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST): ${url}`;
    const res = await sendKycSms({ mobile_number: agent.phone.trim(), message: msg, channel, templateParams: [url] });
    // A SKIPPED send means the SMS provider is disabled/unconfigured — the agent
    // received nothing, so it must NOT be reported as success (else the panel
    // would falsely say "link sent"). Surface it so the Coordinator can resend
    // or fall back to Email / Copy link.
    if (!res.success) {
      const reason = res.skipped
        ? `SMS provider is not enabled/configured (${res.error ?? "sms_disabled"}). Configure SMS env, or use Email / Copy link.`
        : res.error ?? "SMS dispatch failed";
      return { ok: false, channel, error: reason };
    }
    return { ok: true, channel };
  } catch (e) {
    return { ok: false, channel, error: e instanceof Error ? e.message : String(e) };
  }
}
