// Tests for what a campaign call ENDED as.
//
// The first block is the acceptance list from the fix request, one case per
// telephony result. The rest pin the evidence order and the carrier-announcement
// guard, which is where "Completed" used to be inflated: a transcript existed,
// so the call counted, whether or not the dealer ever said a word.

import { describe, expect, it } from "vitest";
import {
    ANNOUNCEMENT_PATTERN,
    ATTEMPTED_STATUSES,
    CAMPAIGN_LEAD_STATUSES,
    CAMPAIGN_LEAD_STATUS_LABELS,
    NON_CONVERSATION_STATUSES,
    RETRYABLE_STATUSES,
    TERMINAL_STATUSES,
    campaignLeadStatusLabel,
    classifyCallEnd,
    classifyCarrierAnnouncement,
    dealerSpoke,
    dealerSpokeSql,
    reclassifyStoredAttempt,
    sqlStatusList,
} from "@/lib/ai-dialer/campaignLeadStatus";

const agent = "agent: नमस्ते sir! Priya बोल रही हूँ iTarang से।";

describe("the six telephony results in the fix request", () => {
    it("customer answers and the AI conversation starts → completed", () => {
        expect(
            classifyCallEnd({
                providerStatus: "done",
                transcript: `${agent}\nuser: हाँ बोलिए, कौन?`,
            }).status,
        ).toBe("completed");
    });

    it("phone rings but nobody answers → no_response", () => {
        // ElevenLabs over SIP: the INVITE fails synchronously with a 480.
        expect(
            classifyCallEnd({
                triggerError:
                    "trigger_failed: INVITE failed: sip status: 480: Temporarily Unavailable (SIP 480)",
            }).status,
        ).toBe("no_response");
        // Bolna reports it as a status.
        expect(classifyCallEnd({ providerStatus: "no-answer" }).status).toBe("no_response");
        // ElevenLabs call_initiation_failure.
        expect(classifyCallEnd({ initiationFailureReason: "no-answer" }).status).toBe(
            "no_response",
        );
    });

    it("busy number → busy", () => {
        expect(
            classifyCallEnd({
                triggerError: "trigger_failed: INVITE failed: sip status: 486: Busy Here (SIP 486)",
            }).status,
        ).toBe("busy");
        expect(classifyCallEnd({ providerStatus: "busy" }).status).toBe("busy");
        expect(classifyCallEnd({ initiationFailureReason: "busy" }).status).toBe("busy");
    });

    it("call rejected → rejected", () => {
        expect(
            classifyCallEnd({
                triggerError: "trigger_failed: INVITE failed: sip status: 603: Decline",
            }).status,
        ).toBe("rejected");
        expect(classifyCallEnd({ sipStatusCode: 603 }).status).toBe("rejected");
        expect(classifyCallEnd({ providerStatus: "rejected" }).status).toBe("rejected");
    });

    it("call fails → failed", () => {
        expect(
            classifyCallEnd({
                triggerError:
                    "trigger_failed: Calling from_number doesn't exist for vobiz. Please check your agent telephony provider.",
            }).status,
        ).toBe("failed");
        expect(classifyCallEnd({ triggerError: "trigger_failed: sip request timed out" }).status).toBe(
            "failed",
        );
        expect(classifyCallEnd({ providerStatus: "failed" }).status).toBe("failed");
        expect(classifyCallEnd({ providerStatus: "error" }).status).toBe("failed");
        expect(classifyCallEnd({}).status).toBe("failed");
    });

    it("voicemail → voicemail", () => {
        // Bolna's AMD flag.
        expect(
            classifyCallEnd({
                providerStatus: "completed",
                transcript: `${agent}\nuser: हेलो`,
                answeredByVoicemail: true,
            }).status,
        ).toBe("voicemail");
        // ElevenLabs voicemail-detection termination.
        expect(
            classifyCallEnd({
                providerStatus: "done",
                transcript: agent,
                terminationReason: "Voicemail detected",
            }).status,
        ).toBe("voicemail");
        // A voicemail greeting transcribed as the dealer.
        expect(
            classifyCallEnd({
                providerStatus: "done",
                transcript: `${agent}\nuser: Please leave a message after the beep.`,
            }).status,
        ).toBe("voicemail");
    });
});

describe("attempted, but no conversation → no_conversation (labelled Pending)", () => {
    it("the AI greeted a line where the dealer never spoke", () => {
        // THE inflation: 481 rows on prod were this shape and read "Completed".
        expect(classifyCallEnd({ providerStatus: "done", transcript: agent }).status).toBe(
            "no_conversation",
        );
    });

    it("a dealer turn with no words in it is not speech", () => {
        expect(
            classifyCallEnd({ providerStatus: "done", transcript: `${agent}\nuser: ...` }).status,
        ).toBe("no_conversation");
        expect(
            classifyCallEnd({ providerStatus: "done", transcript: `${agent}\nuser: …` }).status,
        ).toBe("no_conversation");
        expect(
            classifyCallEnd({ providerStatus: "done", transcript: `${agent}\nuser:` }).status,
        ).toBe("no_conversation");
    });

    it("finished normally with nothing exchanged at all", () => {
        expect(classifyCallEnd({ providerStatus: "completed" }).status).toBe("no_conversation");
        expect(classifyCallEnd({ providerStatus: "done", transcript: "" }).status).toBe(
            "no_conversation",
        );
    });

    it("is labelled Pending, and the queue reads Queued so the two never share a word", () => {
        expect(CAMPAIGN_LEAD_STATUS_LABELS.no_conversation).toBe("Pending");
        expect(CAMPAIGN_LEAD_STATUS_LABELS.pending).toBe("Queued");
    });
});

describe("carrier announcements are not the dealer speaking", () => {
    const cases: [string, "busy" | "no_response" | "voicemail" | "failed"][] = [
        ["The number you are calling is busy, please try again later.", "busy"],
        ["आप जिस नंबर से संपर्क करना चाहते हैं वह अभी व्यस्त है, कृपया थोड़ी देर बाद प्रयास करें।", "busy"],
        ["The person you are calling is not answering.", "no_response"],
        ["The number you have dialled is currently switched off.", "no_response"],
        ["आप जिस नंबर पर कॉल कर रहे हैं वह अभी बंद है।", "no_response"],
        ["The number you have dialled is not reachable.", "no_response"],
        ["The number you have dialled does not exist.", "failed"],
        ["यह नंबर मौजूद नहीं है।", "failed"],
        ["Your call has been forwarded to voicemail.", "voicemail"],
    ];

    for (const [announcement, status] of cases) {
        it(`"${announcement.slice(0, 40)}…" → ${status}`, () => {
            const transcript = `${agent}\nuser: ${announcement}`;
            expect(dealerSpoke(transcript)).toBe(false);
            expect(classifyCallEnd({ providerStatus: "done", transcript }).status).toBe(status);
        });
    }

    it("an invalid number says so in the outcome", () => {
        expect(
            classifyCallEnd({
                providerStatus: "done",
                transcript: `${agent}\nuser: The number you have dialled does not exist.`,
            }).outcome,
        ).toBe("invalid_number");
    });

    // The guard is the FRAME, not the keyword. These are all things a real
    // dealer says, and every one of them is a conversation.
    it("does not mistake a busy / closed dealer for a recording", () => {
        for (const said of [
            "abhi main busy hoon, baad mein call karo",
            "मैं अभी व्यस्त हूँ",
            "दुकान अभी बंद है",
            "please call later",
            "नंबर गलत है भाई, यहाँ कोई ऐसा नहीं है",
        ]) {
            const transcript = `${agent}\nuser: ${said}`;
            expect(dealerSpoke(transcript), said).toBe(true);
            expect(classifyCallEnd({ providerStatus: "done", transcript }).status, said).toBe(
                "completed",
            );
        }
    });

    it("a real turn after an announcement still counts", () => {
        const transcript = `${agent}\nuser: The number you are calling is busy\nuser: haan haan bolo`;
        expect(dealerSpoke(transcript)).toBe(true);
    });

    it("returns null for ordinary speech", () => {
        expect(classifyCarrierAnnouncement("हाँ जी बताइए")).toBeNull();
        expect(classifyCarrierAnnouncement("")).toBeNull();
        expect(classifyCarrierAnnouncement(null)).toBeNull();
    });
});

describe("evidence order", () => {
    it("the dealer speaking outranks a stale trigger error", () => {
        expect(
            classifyCallEnd({
                transcript: `${agent}\nuser: hello?`,
                triggerError: "trigger_failed: INVITE failed: sip status: 486: Busy Here",
            }).status,
        ).toBe("completed");
    });

    it("voicemail outranks the transcript", () => {
        expect(
            classifyCallEnd({
                transcript: `${agent}\nuser: hi, you have reached Ramesh`,
                answeredByVoicemail: true,
            }).status,
        ).toBe("voicemail");
    });

    it("a telephony failure outranks an agent-only transcript", () => {
        expect(
            classifyCallEnd({ transcript: agent, initiationFailureReason: "busy" }).status,
        ).toBe("busy");
    });

    it("an unrecognised telephony string falls through to the transcript", () => {
        expect(
            classifyCallEnd({ transcript: agent, initiationFailureReason: "unknown" }).status,
        ).toBe("no_conversation");
    });

    it("does not read a SIP code out of the digits of a phone number", () => {
        // "+919876034871" contains "603" — read as a code, this 480 would
        // become Rejected, because 603 is checked before 480.
        expect(
            classifyCallEnd({
                triggerError:
                    "trigger_failed: sip status: 480: Temporarily Unavailable to +919876034871",
            }).status,
        ).toBe("no_response");
    });

    it("Bolna's balance-low is a dialer failure, not the dealer's", () => {
        expect(classifyCallEnd({ providerStatus: "balance-low" }).status).toBe("failed");
    });
});

describe("vocabulary invariants", () => {
    it("every status has a label", () => {
        for (const s of CAMPAIGN_LEAD_STATUSES) {
            expect(CAMPAIGN_LEAD_STATUS_LABELS[s].length, s).toBeGreaterThan(0);
        }
    });

    it("the sets nest the way the counters assume", () => {
        const attempted = new Set<string>(ATTEMPTED_STATUSES);
        expect(attempted.has("pending")).toBe(false);
        expect(attempted.has("calling")).toBe(false);
        expect(attempted.has("skipped")).toBe(false);
        expect(NON_CONVERSATION_STATUSES).not.toContain("completed");
        for (const s of NON_CONVERSATION_STATUSES) expect(attempted.has(s)).toBe(true);
        expect([...RETRYABLE_STATUSES]).toEqual([...NON_CONVERSATION_STATUSES]);
        expect(TERMINAL_STATUSES).toContain("skipped");
        expect(TERMINAL_STATUSES).not.toContain("pending");
    });

    it("classifyCallEnd only ever returns an attempted status", () => {
        const inputs = [
            {},
            { providerStatus: "done" },
            { providerStatus: "stopped" },
            { providerStatus: "canceled" },
            { transcript: agent },
            { triggerError: "trigger_exception: boom" },
            { sipStatusCode: "abc" },
        ];
        for (const e of inputs) {
            expect((ATTEMPTED_STATUSES as readonly string[]).includes(classifyCallEnd(e).status)).toBe(
                true,
            );
        }
    });

    it("an unknown status label falls back to the raw value, never to Pending", () => {
        expect(campaignLeadStatusLabel("mystery")).toBe("mystery");
        expect(campaignLeadStatusLabel(null)).toBe("—");
    });

    it("renders a raw-SQL IN list", () => {
        expect(sqlStatusList(["busy", "failed"])).toBe("'busy', 'failed'");
    });
});

describe("the SQL twin", () => {
    it("spells the same shape as the JS reader", () => {
        const s = dealerSpokeSql("acl");
        expect(s).toContain("regexp_split_to_table(acl.transcript, E'\\n')");
        expect(s).toContain("~* '^user: ?.*[^[:space:][:punct:]…।]'");
        expect(s).toContain("!~*");
    });

    it("quotes the announcement pattern safely", () => {
        // "doesn't" / "you're" carry apostrophes; an unescaped one would end the
        // SQL literal early.
        expect(ANNOUNCEMENT_PATTERN).toContain("you're");
        expect(dealerSpokeSql("acl")).toContain("you''re");
        expect(dealerSpokeSql("acl")).not.toMatch(/[^']'re/);
    });
});

describe("reclassifyStoredAttempt — the backfill's rule", () => {
    const base = { callOutcome: null, transcript: null, providerStatus: null };

    it("never touches a row that is still queued or on a call", () => {
        expect(reclassifyStoredAttempt({ ...base, status: "pending" })).toBeNull();
        expect(reclassifyStoredAttempt({ ...base, status: "calling" })).toBeNull();
    });

    it("the inflated 'completed' row: AI greeted, dealer silent → no_conversation", () => {
        expect(
            reclassifyStoredAttempt({
                status: "completed",
                callOutcome: "dropped_empty",
                transcript: agent,
                providerStatus: "done",
            })?.status,
        ).toBe("no_conversation");
    });

    it("a real conversation stays completed", () => {
        expect(
            reclassifyStoredAttempt({
                status: "completed",
                callOutcome: "interested",
                transcript: `${agent}\nuser: haan bataiye`,
                providerStatus: "done",
            })?.status,
        ).toBe("completed");
    });

    it("splits the trigger failures by SIP code", () => {
        const t = (callOutcome: string) =>
            reclassifyStoredAttempt({ ...base, status: "failed", callOutcome })?.status;
        expect(t("trigger_failed: INVITE failed: sip status: 486: Busy Here (SIP 486)")).toBe("busy");
        expect(t("trigger_failed: INVITE failed: sip status: 480: Temporarily Unavailable")).toBe(
            "no_response",
        );
        expect(t("trigger_failed: INVITE failed: sip status: 603: Decline")).toBe("rejected");
        expect(t("trigger_failed: Invalid API key")).toBe("failed");
        expect(t("trigger_failed")).toBe("failed");
    });

    it("reads an ElevenLabs initiation-failure reason stored as the outcome", () => {
        expect(
            reclassifyStoredAttempt({ ...base, status: "failed", callOutcome: "busy" })?.status,
        ).toBe("busy");
        expect(
            reclassifyStoredAttempt({ ...base, status: "failed", callOutcome: "no-answer" })?.status,
        ).toBe("no_response");
    });

    it("moves never-dialled rows to skipped", () => {
        for (const callOutcome of ["no_phone", "ineligible_active_lead", "ineligible_ai_connected"]) {
            expect(
                reclassifyStoredAttempt({ ...base, status: "failed", callOutcome })?.status,
            ).toBe("skipped");
        }
    });

    it("keeps our own failures failed, unless a transcript turned up later", () => {
        expect(
            reclassifyStoredAttempt({ ...base, status: "failed", callOutcome: "no_webhook" })?.status,
        ).toBe("failed");
        expect(
            reclassifyStoredAttempt({
                status: "failed",
                callOutcome: "no_webhook",
                transcript: `${agent}\nuser: hello`,
                providerStatus: "done",
            })?.status,
        ).toBe("completed");
    });

    it("is idempotent — a re-classified row re-classifies to itself", () => {
        const rows = [
            { status: "completed", callOutcome: "dropped_empty", transcript: agent, providerStatus: "done" },
            { status: "failed", callOutcome: "trigger_failed: sip status: 486: Busy Here", transcript: null, providerStatus: null },
            { status: "failed", callOutcome: "no_phone", transcript: null, providerStatus: null },
            { status: "completed", callOutcome: "interested", transcript: `${agent}\nuser: ji`, providerStatus: "done" },
        ];
        for (const r of rows) {
            const once = reclassifyStoredAttempt(r)!;
            const twice = reclassifyStoredAttempt({
                ...r,
                status: once.status,
                callOutcome: once.outcome ?? r.callOutcome,
            })!;
            expect(twice.status).toBe(once.status);
        }
    });
});

describe("calibration — announcements seen in stored transcripts", () => {
    // Sandbox, 2026-09-21: the one carrier recording among 83 transcripts.
    it("the 'person you have reached … at the tone' voicemail greeting", () => {
        const text =
            "The person you have reached is not available. At the tone, please record your message. When you have finished recording, you may hang up.";
        expect(classifyCarrierAnnouncement(text)).toBe("voicemail");
        expect(classifyCallEnd({ providerStatus: "done", transcript: `${agent}\nuser: ${text}` }).status).toBe(
            "voicemail",
        );
    });
});
