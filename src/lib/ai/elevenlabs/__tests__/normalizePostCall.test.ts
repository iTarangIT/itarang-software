import { describe, expect, it } from "vitest";

import {
  callDuration,
  callEndedAt,
  callStartedAt,
  normalizePostCall,
  transcriptArrayToString,
} from "../normalizePostCall";
import type { ElevenLabsPostCallTranscriptionData } from "../types";

/**
 * Regression tests for the August 2026 data loss.
 *
 * The Ops Console reported 0 calls, ₹0 and 0s talk time for a month in which
 * ElevenLabs had recorded 738 conversations, 10,819 seconds and 81,682 credits.
 * Credits were right because they come from the vendor API; the other three are
 * read from ai_call_logs, which had no rows at all.
 *
 * Three defects in this normalization contributed, and each has a test below:
 * write-time timestamps, a hardcoded "completed" status, and an ignored
 * lead-id. The shapes used here are taken from real August conversations.
 */

/** A real August 2026 outbound call: connected, billed, attributable. */
function connectedCall(): ElevenLabsPostCallTranscriptionData {
  return {
    agent_id: "agent_3901kv834mh7ehqae8e7ew1mwbaz",
    conversation_id: "conv_7901kzxas8zvfx8rmmd0thrzp3n5",
    status: "done",
    transcript: [
      { role: "agent", message: "Namaste, main Priya bol rahi hoon." },
      { role: "user", message: "Haan boliye." },
    ],
    metadata: {
      start_time_unix_secs: 1786690000,
      call_duration_secs: 11,
      phone_call: { external_number: "+918319656435" },
    },
    conversation_initiation_client_data: {
      dynamic_variables: {
        lead_id: "L-aQIUyvEv",
        phone_number: "+918319656435",
      },
    },
  };
}

/** A real August 2026 failed dial: 390 of the month's 738 looked like this. */
function failedCall(): ElevenLabsPostCallTranscriptionData {
  return {
    agent_id: "agent_3901kv834mh7ehqae8e7ew1mwbaz",
    conversation_id: "conv_3201kzxaqqd2f0v904ew9v62qbd2",
    status: "failed",
    transcript: [],
    metadata: {
      start_time_unix_secs: 1786690000,
      call_duration_secs: 0,
      phone_call: { external_number: "+917440357440" },
    },
    conversation_initiation_client_data: {
      dynamic_variables: { lead_id: "L-p5pnhRvx" },
    },
  };
}

describe("callStartedAt / callEndedAt — the provider's clock", () => {
  it("reads start_time_unix_secs as SECONDS, not milliseconds", () => {
    // Treating it as ms would date every call to 1970 and empty every window
    // on the dashboard.
    const started = callStartedAt(connectedCall().metadata);
    expect(started?.toISOString()).toBe("2026-08-14T06:46:40.000Z");
    expect(started!.getUTCFullYear()).toBe(2026);
  });

  it("derives ended_at as start + duration", () => {
    const meta = connectedCall().metadata;
    expect(callEndedAt(meta)!.getTime() - callStartedAt(meta)!.getTime()).toBe(
      11_000,
    );
  });

  it("gives a zero-duration failed call a non-null ended_at", () => {
    // THE August regression. Every query on /operations/elevenlabs compares
    // against ended_at, and NULL fails a comparison — so a NULL here means the
    // row is stored and then counted by nothing: not the tiles, not
    // first_call_at, not the month dropdown.
    const meta = failedCall().metadata;
    const ended = callEndedAt(meta);
    expect(ended).not.toBeNull();
    expect(ended!.getTime()).toBe(callStartedAt(meta)!.getTime());
  });

  it("keeps a failed call inside August rather than nowhere", () => {
    const ended = callEndedAt(failedCall().metadata)!;
    const istMonth = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
    }).format(ended);
    expect(istMonth).toBe("2026-08");
  });

  it("returns null — never a fabricated now() — when the provider sent no clock", () => {
    expect(callStartedAt({})).toBeNull();
    expect(callEndedAt({})).toBeNull();
    expect(callStartedAt(undefined)).toBeNull();
    expect(callStartedAt({ start_time_unix_secs: 0 })).toBeNull();
  });
});

describe("callDuration — null and zero are different answers", () => {
  it("keeps 0 as 0", () => {
    // 0 is "connected to nothing"; null is "we do not know". Collapsing them
    // would make talk time unverifiable.
    expect(callDuration(failedCall().metadata)).toBe(0);
  });

  it("returns null when absent or not a finite number", () => {
    expect(callDuration({})).toBeNull();
    expect(callDuration({ call_duration_secs: Number.NaN })).toBeNull();
    expect(callDuration(undefined)).toBeNull();
  });
});

describe("normalizePostCall — status", () => {
  it("reports a failed call as failed", () => {
    // Previously hardcoded to "completed", which recorded all 390 of August's
    // failed dials as successes.
    expect(normalizePostCall(failedCall()).status).toBe("failed");
  });

  it("reports a connected call with the provider's own word", () => {
    expect(normalizePostCall(connectedCall()).status).toBe("done");
  });

  it("falls back to completed only when the provider said nothing", () => {
    const d = connectedCall();
    delete d.status;
    expect(normalizePostCall(d).status).toBe("completed");
  });
});

describe("normalizePostCall — lead attribution", () => {
  it("uses the lead_id the app put on the call", () => {
    expect(normalizePostCall(connectedCall()).leadId).toBe("L-aQIUyvEv");
  });

  it("treats a blank lead_id as absent", () => {
    const d = connectedCall();
    d.conversation_initiation_client_data!.dynamic_variables!.lead_id = "  ";
    expect(normalizePostCall(d).leadId).toBeUndefined();
  });

  it("survives an inbound call that has no client data at all", () => {
    // The 40 inbound August calls. These must still normalize — dropping them
    // is what the finalize path used to do.
    const inbound: ElevenLabsPostCallTranscriptionData = {
      agent_id: "agent_7901kssfam95fkg9x174pp2e47fn",
      conversation_id: "conv_6501m01ws08jefrtt3ywwqhtrbzq",
      status: "done",
      metadata: {
        start_time_unix_secs: 1786770129,
        call_duration_secs: 31,
        phone_call: { external_number: "01409032295" },
      },
    };
    const call = normalizePostCall(inbound);
    expect(call.leadId).toBeUndefined();
    expect(call.phone).toBe("01409032295");
    expect(call.duration).toBe(31);
    expect(call.endedAt).not.toBeNull();
    expect(call.agentId).toBe("agent_7901kssfam95fkg9x174pp2e47fn");
  });
});

describe("normalizePostCall — the whole payload", () => {
  it("carries every field the dashboard aggregates", () => {
    const call = normalizePostCall(connectedCall());
    expect(call).toMatchObject({
      conversationId: "conv_7901kzxas8zvfx8rmmd0thrzp3n5",
      status: "done",
      duration: 11,
      phone: "+918319656435",
      leadId: "L-aQIUyvEv",
      agentId: "agent_3901kv834mh7ehqae8e7ew1mwbaz",
    });
    expect(call.transcript).toBe(
      "agent: Namaste, main Priya bol rahi hoon.\nuser: Haan boliye.",
    );
  });

  it("is deterministic — the same delivery normalizes identically twice", () => {
    // Redelivery must upsert onto the same row with the same values rather
    // than drifting, which a write-time ended_at could not guarantee.
    const a = normalizePostCall(connectedCall());
    const b = normalizePostCall(connectedCall());
    expect(a.endedAt!.getTime()).toBe(b.endedAt!.getTime());
    expect(a.startedAt!.getTime()).toBe(b.startedAt!.getTime());
    expect(a.conversationId).toBe(b.conversationId);
  });

  it("returns a null transcript for a call with no turns", () => {
    expect(normalizePostCall(failedCall()).transcript).toBeNull();
  });
});

describe("transcriptArrayToString", () => {
  it("labels speakers and drops empty turns", () => {
    expect(
      transcriptArrayToString([
        { role: "agent", message: "Hello" },
        { role: "user", message: "   " },
        { role: "user", message: "Hi" },
      ]),
    ).toBe("agent: Hello\nuser: Hi");
  });

  it("returns empty string for missing or empty input", () => {
    expect(transcriptArrayToString(undefined)).toBe("");
    expect(transcriptArrayToString([])).toBe("");
  });
});
