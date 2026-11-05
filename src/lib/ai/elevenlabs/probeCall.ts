// Carrier probe (Priya KPI tracker task 10) — one outbound call to a fixed
// number, to learn whether the carrier is accepting our calls again.
//
// Not triggerElevenLabsCall: that one needs a lead for the number and writes
// lead state. A probe has no lead. It rings the team's own number with the
// same agent and from-number a campaign uses, so "placed" means a campaign
// dial would be placed too. The agent's prompt reads every dynamic variable
// below, so each is sent (empty where it has no meaning); is_probe = "1" lets
// the webhook drop the conversation instead of logging it as a dealer call.

import { normalizeIndianPhone } from "@/lib/ai/phone";
import { lineBlockKind } from "@/lib/ai-dialer/carrierPause";

export type ProbeResult = {
    /** The carrier took the call (placed, or the probe phone was busy / unanswered). */
    placed: boolean;
    /** Provider text for a refusal, or the conversation id for a placed call. */
    detail: string;
};

function outboundUrl(): string {
    const provider = (process.env.ELEVENLABS_PHONE_PROVIDER || "twilio").toLowerCase().trim();
    return ["sip", "sip-trunk", "sip_trunk"].includes(provider)
        ? "https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call"
        : "https://api.elevenlabs.io/v1/convai/twilio/outbound-call";
}

export const PROBE_DYNAMIC_VARIABLES = {
    lead_id: "",
    owner_name: "",
    location: "",
    shop_name: "iTarang line check",
    language: "",
    interest: "cold",
    status: "",
    total_attempts: "0",
    is_followup: "false",
    last_call_memory: "",
    persistent_memory: "",
    timezone: "Asia/Kolkata",
    short_opener: "0",
    ask_owner_mobile: "0",
    last_disposition_rule: "",
    is_probe: "1",
} as const;

/**
 * Place the probe. A refusal on OUR side (401/403/407/429/503, or a config
 * error) is "not placed"; anything that reached the carrier — including busy
 * or no answer on the probe phone — is "placed": the line works.
 */
export async function placeProbeCall(number: string): Promise<ProbeResult> {
    const to = normalizeIndianPhone(number);
    if (!to) return { placed: false, detail: `invalid probe number: ${number}` };
    if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_AGENT_ID || !process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID) {
        return { placed: false, detail: "ElevenLabs is not configured on this server" };
    }
    try {
        const res = await fetch(outboundUrl(), {
            method: "POST",
            headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
                agent_id: process.env.ELEVENLABS_AGENT_ID,
                agent_phone_number_id: process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID,
                to_number: to,
                conversation_initiation_client_data: {
                    dynamic_variables: { ...PROBE_DYNAMIC_VARIABLES, phone_number: to },
                },
                call_recording_enabled: false,
            }),
        });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
            detail?: { message?: string };
        };
        if (res.ok && json?.success !== false) {
            return { placed: true, detail: String(json?.conversation_id ?? "placed") };
        }
        const error = String(
            json?.message || json?.detail?.message || json?.error || `ElevenLabs call failed (HTTP ${res.status})`,
        ).slice(0, 300);
        // Same reading as a campaign trigger failure.
        return { placed: lineBlockKind(`trigger_failed: ${error}`) === null, detail: error };
    } catch (err) {
        return { placed: false, detail: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
}
