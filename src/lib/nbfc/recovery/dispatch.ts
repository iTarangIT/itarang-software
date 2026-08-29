/**
 * E-262 — routes a recovery agent's link (and its cancellation) over
 * Email / SMS / WhatsApp.
 *
 * Modelled on `fi-dispatch.ts`, including the two things that module learned
 * the hard way:
 *
 *   1. IT NEVER THROWS. A dispatch failure comes back as `{ ok: false, error }`
 *      so the caller can save the assignment and offer a Resend, rather than
 *      500ing and losing the row that was already written.
 *
 *   2. A SKIPPED SMS IS A FAILURE. `sendKycSms` returns `skipped` when the
 *      provider is unconfigured — nobody received anything — and reporting that
 *      as success is what makes a screen say "link sent" when it was not.
 *
 * The coordinator may pick a wire explicitly; when they do it is honoured and a
 * missing contact is an error rather than a silent re-route to whatever wire we
 * happen to have. With no explicit choice, the agent's preferred channel wins
 * and email is the universal fallback.
 */
import { sendKycSms } from "@/lib/sms";
import type { RecoveryAgent, RecoveryChannel } from "@/lib/nbfc/recovery/agents";
import { sendRecoveryAgentLinkEmail } from "@/lib/email/sendRecoveryAgentLinkEmail";
import {
  sendRecoveryCancelledEmail,
  type RecoveryCancelSource,
} from "@/lib/email/sendRecoveryCancelledEmail";

export interface DispatchResult {
  ok: boolean;
  channel: RecoveryChannel | null;
  error?: string;
}

/**
 * Which wire to use, given what the agent has on file. Shared by both senders
 * so a cancellation goes out the same way the assignment did.
 */
function pickChannel(
  agent: RecoveryAgent,
  explicit?: RecoveryChannel,
): { channel: RecoveryChannel } | { error: string } {
  const hasEmail = !!agent.email?.trim();
  const hasPhone = !!agent.phone?.trim();

  if (explicit) {
    if (explicit === "email" && !hasEmail) {
      return {
        error:
          "This agent has no email on file. Add one in the Recovery Agent directory, or pick SMS / WhatsApp.",
      };
    }
    if ((explicit === "sms" || explicit === "whatsapp") && !hasPhone) {
      return {
        error:
          "This agent has no phone on file. Add one in the Recovery Agent directory, or pick Email.",
      };
    }
    return { channel: explicit };
  }

  const preferred = (agent.preferred_channel as RecoveryChannel) || "email";
  if (preferred === "email" && hasEmail) return { channel: "email" };
  if ((preferred === "sms" || preferred === "whatsapp") && hasPhone) {
    return { channel: preferred };
  }
  if (hasEmail) return { channel: "email" };
  if (hasPhone) return { channel: "sms" };
  return { error: "Agent has neither email nor phone on file." };
}

export interface DispatchRecoveryLinkInput {
  agent: RecoveryAgent;
  url: string;
  borrowerName: string;
  borrowerPhone?: string | null;
  address?: string | null;
  city?: string | null;
  batterySerial?: string | null;
  expiresAt: Date;
  nbfcName?: string | null;
  resend?: boolean;
  /** Explicit coordinator choice; overrides the agent's preferred channel. */
  channel?: RecoveryChannel;
}

export async function dispatchRecoveryLink(
  input: DispatchRecoveryLinkInput,
): Promise<DispatchResult> {
  const picked = pickChannel(input.agent, input.channel);
  if ("error" in picked) {
    return { ok: false, channel: input.channel ?? null, error: picked.error };
  }
  const channel = picked.channel;

  try {
    if (channel === "email") {
      await sendRecoveryAgentLinkEmail({
        toEmail: input.agent.email!.trim(),
        agentName: input.agent.name,
        borrowerName: input.borrowerName,
        borrowerPhone: input.borrowerPhone ?? null,
        address: input.address ?? null,
        city: input.city ?? input.agent.city ?? null,
        batterySerial: input.batterySerial ?? null,
        url: input.url,
        expiresAt: input.expiresAt,
        nbfcName: input.nbfcName ?? null,
        resend: input.resend,
      });
      return { ok: true, channel };
    }

    const expiry = input.expiresAt.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    });
    // The borrower's number rides along here too — an agent who got the job by
    // SMS has no email to look it up in.
    const msg =
      `iTarang: battery collection for ${input.borrowerName}` +
      (input.batterySerial ? ` (${input.batterySerial})` : "") +
      (input.borrowerPhone ? `, ph ${input.borrowerPhone}` : "") +
      `. Open on your phone at the address (expires ${expiry} IST): ${input.url}`;
    const res = await sendKycSms({
      mobile_number: input.agent.phone.trim(),
      message: msg,
      channel,
      templateParams: [input.url],
    });
    if (!res.success) {
      return {
        ok: false,
        channel,
        error: res.skipped
          ? `SMS provider is not enabled/configured (${res.error ?? "sms_disabled"}). Configure SMS env, or use Email / Copy link.`
          : (res.error ?? "SMS dispatch failed"),
      };
    }
    return { ok: true, channel };
  } catch (e) {
    return {
      ok: false,
      channel,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface DispatchRecoveryCancelInput {
  agent: RecoveryAgent;
  borrowerName: string;
  city?: string | null;
  batterySerial?: string | null;
  source: RecoveryCancelSource;
  reason?: string | null;
  nbfcName?: string | null;
  channel?: RecoveryChannel;
}

/**
 * The stand-down message. Sent on the same wire the job went out on, because an
 * agent who received the job by SMS will not be reading email on a doorstep.
 */
export async function dispatchRecoveryCancellation(
  input: DispatchRecoveryCancelInput,
): Promise<DispatchResult> {
  const picked = pickChannel(input.agent, input.channel);
  if ("error" in picked) {
    return { ok: false, channel: input.channel ?? null, error: picked.error };
  }
  const channel = picked.channel;

  try {
    if (channel === "email") {
      await sendRecoveryCancelledEmail({
        toEmail: input.agent.email!.trim(),
        agentName: input.agent.name,
        borrowerName: input.borrowerName,
        city: input.city ?? input.agent.city ?? null,
        batterySerial: input.batterySerial ?? null,
        source: input.source,
        reason: input.reason ?? null,
        nbfcName: input.nbfcName ?? null,
      });
      return { ok: true, channel };
    }

    // Front-loaded, because a phone truncates. The first six words have to carry
    // the whole instruction even if nothing else arrives.
    const why =
      input.source === "emi_payment"
        ? "the borrower has paid"
        : input.source === "reassigned"
          ? "it has been passed to another agent"
          : "it has been cancelled";
    const msg =
      `iTarang: DO NOT COLLECT the battery for ${input.borrowerName}` +
      (input.batterySerial ? ` (${input.batterySerial})` : "") +
      ` — ${why}. Your collection link no longer works.`;
    const res = await sendKycSms({
      mobile_number: input.agent.phone.trim(),
      message: msg,
      channel,
    });
    if (!res.success) {
      return {
        ok: false,
        channel,
        error: res.skipped
          ? `SMS provider is not enabled/configured (${res.error ?? "sms_disabled"}).`
          : (res.error ?? "SMS dispatch failed"),
      };
    }
    return { ok: true, channel };
  } catch (e) {
    return {
      ok: false,
      channel,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
