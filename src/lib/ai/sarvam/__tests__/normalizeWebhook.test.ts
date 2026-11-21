import { describe, expect, it } from "vitest";
import {
  agentVariable,
  canonicalYesNo,
  isSarvamConnected,
  normalizeSarvamWebhook,
  sarvamDuration,
  sarvamNotConnectedEvidence,
  sarvamTranscriptToString,
  yesNo,
} from "../normalizeWebhook";
import { classifyCallEnd } from "@/lib/ai-dialer/campaignLeadStatus";
import type { SarvamWebhookPayload } from "../types";

const APP_ID = "Priya---iTa-44bf0300-67c5";
const RECEIVED = new Date("2026-11-20T10:00:00.000Z");

// The three documented shapes (handoff spec, "Call-end webhook").
function connectedCall(over: Partial<SarvamWebhookPayload> = {}): SarvamWebhookPayload {
  return {
    attempt_id: "att_123",
    status: "connected",
    duration: 95,
    interaction_id: "20261120/abc",
    failure_reason: null,
    final_agent_variables: {
      answered_by: "owner",
      call_result: "interested",
      callback_agreed: "yes",
      callback_time: "kal shaam 5 baje",
      intent_score: "72",
      lead_qualified: "true",
    },
    interaction_transcript: [
      { role: "agent", en_text: "Am I speaking with Gupta Battery?" },
      { role: "user", en_text: "Yes, tell me." },
      { role: "agent", en_text: "  " },
    ],
    webhook_config: {
      url: "https://crm.example.com/api/sarvam/webhook?token=x",
      metadata: { lead_id: "L-abc12345", phone: "+919876543210" },
    },
    channel_info: { channel_provider: "exotel", agent_phone_number: "+918000000000" },
    ...over,
  };
}

function notConnected(status: string, failure_reason: string | null = null): SarvamWebhookPayload {
  return {
    attempt_id: "att_9",
    status,
    duration: null,
    interaction_id: null,
    failure_reason,
    final_agent_variables: null,
    interaction_transcript: null,
    webhook_config: { metadata: { lead_id: "L-1", phone: "+919000000000" } },
  };
}

describe("connected call → finalize payload", () => {
  const n = normalizeSarvamWebhook(connectedCall(), { receivedAt: RECEIVED, appId: APP_ID });

  it("uses attempt_id as the call id and tags the provider", () => {
    expect(n.conversationId).toBe("att_123");
    expect(n.provider).toBe("sarvam");
    expect(n.agentId).toBe(APP_ID);
  });

  it("maps connected to a status classifyCallEnd treats as a finished call", () => {
    expect(n.status).toBe("done");
  });

  it("joins en_text turns as agent:/user: lines and drops blank turns", () => {
    expect(n.transcript).toBe("agent: Am I speaking with Gupta Battery?\nuser: Yes, tell me.");
    expect(n.conversation).toHaveLength(3); // raw array stored verbatim
  });

  it("attributes the lead and phone from the metadata sent at trigger time", () => {
    expect(n.leadId).toBe("L-abc12345");
    expect(n.phone).toBe("+919876543210");
  });

  it("files the call at receipt time and starts it `duration` earlier", () => {
    expect(n.duration).toBe(95);
    expect(n.endedAt?.toISOString()).toBe("2026-11-20T10:00:00.000Z");
    expect(n.startedAt?.toISOString()).toBe("2026-11-20T09:58:25.000Z");
  });

  it("reads the agent's post-call variables", () => {
    expect(n.answeredBy).toBe("owner");
    expect(n.callResult).toBe("interested");
    expect(n.callbackAgreed).toBe("yes");
    expect(n.callLanguage).toBe("hi");
    expect(n.interactionId).toBe("20261120/abc");
    expect(n.terminationReason).toBeNull();
    expect(n.recordingUrl).toBeNull();
  });

  it("keeps Sarvam's own scoring only as a second opinion", () => {
    expect(n.providerExtras).toEqual({
      intentScore: "72",
      leadQualified: "true",
      callbackTime: "kal shaam 5 baje",
      channelProvider: "exotel",
    });
  });

  it("a dealer turn makes classifyCallEnd say completed", () => {
    const c = classifyCallEnd({
      providerStatus: n.status,
      transcript: n.transcript,
      durationSecs: n.duration,
      answeredBy: n.answeredBy,
      callResult: n.callResult,
    });
    expect(c.status).toBe("completed");
  });

  it("switchboard_or_recording retires the number, as for ElevenLabs", () => {
    const sw = normalizeSarvamWebhook(
      connectedCall({
        final_agent_variables: {
          call_result: "switchboard_or_recording",
          answered_by: "switchboard_or_recording",
        },
      }),
      { receivedAt: RECEIVED, appId: APP_ID },
    );
    const c = classifyCallEnd({
      providerStatus: sw.status,
      transcript: sw.transcript,
      callResult: sw.callResult,
      answeredBy: sw.answeredBy,
    });
    expect(c.status).toBe("switchboard");
  });

  it("is deterministic", () => {
    const again = normalizeSarvamWebhook(connectedCall(), { receivedAt: RECEIVED, appId: APP_ID });
    expect(again).toEqual(n);
  });
});

describe("missing values stay missing", () => {
  it("null duration stays null, and so does startedAt", () => {
    const n = normalizeSarvamWebhook(connectedCall({ duration: null }), { receivedAt: RECEIVED, appId: APP_ID });
    expect(n.duration).toBeNull();
    expect(n.startedAt).toBeNull();
    expect(n.endedAt).toEqual(RECEIVED);
  });

  it("no transcript → null, no agent variables → nulls (unverified point 1)", () => {
    const n = normalizeSarvamWebhook(
      connectedCall({ interaction_transcript: null, final_agent_variables: null }),
      { receivedAt: RECEIVED, appId: APP_ID },
    );
    expect(n.transcript).toBeNull();
    expect(n.conversation).toBeUndefined();
    expect(n.answeredBy).toBeNull();
    expect(n.callResult).toBeNull();
    expect(n.callbackAgreed).toBeNull();
  });

  it("no metadata → no lead id and no phone, never a guess", () => {
    const n = normalizeSarvamWebhook(connectedCall({ webhook_config: null }), { receivedAt: RECEIVED, appId: APP_ID });
    expect(n.leadId).toBeUndefined();
    expect(n.phone).toBeNull();
  });
});

describe("not-connected attempts", () => {
  it("only `connected` is connected", () => {
    expect(isSarvamConnected("connected")).toBe(true);
    expect(isSarvamConnected(" Connected ")).toBe(true);
    for (const s of ["no_answer", "busy", "failed", "", null, undefined]) {
      expect(isSarvamConnected(s)).toBe(false);
    }
  });

  it("no_answer → no_response", () => {
    const e = sarvamNotConnectedEvidence(notConnected("no_answer", "Exotel: agent unreachable"));
    expect(e.outcome).toBe("no_answer");
    expect(classifyCallEnd(e).status).toBe("no_response");
  });

  it("busy → busy, even when the carrier text says something else", () => {
    const e = sarvamNotConnectedEvidence(notConnected("busy", "Tata Tele: agent leg dropped"));
    expect(classifyCallEnd(e).status).toBe("busy");
  });

  it("failed keeps the carrier text and lands in a terminal status", () => {
    const e = sarvamNotConnectedEvidence(notConnected("failed", "Exotel: SIP 404 Not Found"));
    expect(e.outcome).toBe("sarvam_failed: Exotel: SIP 404 Not Found");
    expect(classifyCallEnd(e).status).toBe("failed");
  });

  it("failed with no reason still classifies", () => {
    const e = sarvamNotConnectedEvidence(notConnected("failed"));
    expect(e.outcome).toBe("sarvam_failed");
    expect(classifyCallEnd(e).status).toBe("failed");
  });
});

describe("small readers", () => {
  it("sarvamTranscriptToString tolerates junk", () => {
    expect(sarvamTranscriptToString(null)).toBe("");
    expect(sarvamTranscriptToString([{ role: "user", en_text: null }])).toBe("");
    expect(sarvamTranscriptToString([{ role: "USER", en_text: "haan" }])).toBe("user: haan");
  });

  it("agentVariable trims and stringifies", () => {
    expect(agentVariable({ a: " x " }, "a")).toBe("x");
    expect(agentVariable({ a: "  " }, "a")).toBeNull();
    expect(agentVariable({ a: 5 }, "a")).toBe("5");
    expect(agentVariable(null, "a")).toBeNull();
  });

  it("canonicalYesNo keeps unknown text and normalises yes / no", () => {
    expect(canonicalYesNo("Haan")).toBe("yes");
    expect(canonicalYesNo("NO")).toBe("no");
    expect(canonicalYesNo("shayad")).toBe("shayad");
    expect(canonicalYesNo(null)).toBeNull();
  });

  it("yesNo converts Sarvam's yes / no", () => {
    expect(yesNo("yes")).toBe(true);
    expect(yesNo("No")).toBe(false);
    expect(yesNo("maybe")).toBeNull();
    expect(yesNo(null)).toBeNull();
  });

  it("sarvamDuration keeps null as null and rounds", () => {
    expect(sarvamDuration(null)).toBeNull();
    expect(sarvamDuration(0)).toBe(0);
    expect(sarvamDuration(12.6)).toBe(13);
    expect(sarvamDuration("40")).toBe(40);
    expect(sarvamDuration(-1)).toBeNull();
  });
});
