import { describe, expect, it } from "vitest";
import { buildCallQualityFunnel, type CallQualityRow } from "../funnel";

/** One campaign lead as the endpoint hands it over. Sane defaults; override. */
function lead(over: Partial<CallQualityRow> = {}): CallQualityRow {
    return {
        status: "completed",
        callOutcome: null,
        providerDurationSeconds: 30,
        transcript: null,
        infoSignalsCount: null,
        ...over,
    };
}

/** A lead that connected AND has a transcript with the given turns. */
function talked(lines: string[], over: Partial<CallQualityRow> = {}): CallQualityRow {
    return lead({ transcript: lines.join("\n"), ...over });
}

const GREETING = "agent: नमस्ते sir, दो minute बात कर सकते हैं?";

describe("buildCallQualityFunnel — the three populations", () => {
    it("counts attempted over every non-pending lead", () => {
        const out = buildCallQualityFunnel([
            lead({ status: "pending", providerDurationSeconds: null }),
            lead({ status: "completed" }),
            lead({ status: "failed", providerDurationSeconds: null }),
        ]);
        expect(out.attempted).toBe(2);
    });

    it("excludes a call the provider never placed from dialled", () => {
        // trigger_failed means the provider rejected the trigger — no phone
        // rang. Counting it as "dialled" makes a telephony outage look like
        // dealers not answering.
        const out = buildCallQualityFunnel([
            lead({ status: "failed", callOutcome: "trigger_failed", providerDurationSeconds: null }),
            lead({
                status: "failed",
                callOutcome: "trigger_failed: Invalid API key",
                providerDurationSeconds: null,
            }),
            lead({ status: "failed", callOutcome: "busy", providerDurationSeconds: null }),
        ]);
        expect(out.attempted).toBe(3);
        expect(out.dialled).toBe(1);
    });

    it("counts answered on Phase 1's connection rule, never on wall clock", () => {
        const out = buildCallQualityFunnel([
            lead({ providerDurationSeconds: 12 }), // provider talk time
            talked([GREETING], { providerDurationSeconds: null }), // transcript
            lead({ providerDurationSeconds: null }), // neither
            lead({ providerDurationSeconds: 0 }), // zero is not talk time
        ]);
        expect(out.answered).toBe(2);
    });
});

describe("buildCallQualityFunnel — transcript stages", () => {
    it("reports its own denominator rather than borrowing answered", () => {
        const out = buildCallQualityFunnel([
            lead({ providerDurationSeconds: 40 }), // answered, no transcript
            lead({ providerDurationSeconds: 40 }),
            talked([GREETING]), // answered, transcript
        ]);
        expect(out.answered).toBe(3);
        expect(out.withTranscript).toBe(1);
    });

    it("counts a dealer who said anything", () => {
        const out = buildCallQualityFunnel([
            talked([GREETING]),
            talked([GREETING, "user: हाँ"]),
        ]);
        expect(out.withTranscript).toBe(2);
        expect(out.dealerSpoke).toBe(1);
    });

    it("counts the AI getting a second turn as past the opener", () => {
        const out = buildCallQualityFunnel([
            talked([GREETING, "user: हाँ"]),
            talked([GREETING, "user: हाँ", "agent: battery चाहिए?"]),
        ]);
        expect(out.pastOpener).toBe(1);
    });

    it("requires three dealer turns for a meaningful conversation", () => {
        const out = buildCallQualityFunnel([
            talked([GREETING, "user: a", "agent: q", "user: b"]),
            talked([GREETING, "user: a", "agent: q", "user: b", "agent: q2", "user: c"]),
        ]);
        expect(out.meaningfulConversation).toBe(1);
    });
});

describe("buildCallQualityFunnel — qualification has its OWN denominator", () => {
    // info_signals_count is populated on 6 of 298 rows. Folding it into the
    // transcript subset renders it as ~0% and reads as "our calls never
    // qualify" rather than "we almost never score them".
    it("counts only scored calls as the denominator", () => {
        const out = buildCallQualityFunnel([
            talked([GREETING], { infoSignalsCount: 4 }),
            talked([GREETING], { infoSignalsCount: 1 }),
            talked([GREETING], { infoSignalsCount: null }),
            talked([GREETING], { infoSignalsCount: null }),
        ]);
        expect(out.scored).toBe(2);
        expect(out.qualified).toBe(1);
    });

    it("uses the E-168 threshold of three disclosed facts", () => {
        const out = buildCallQualityFunnel([
            talked([GREETING], { infoSignalsCount: 2 }),
            talked([GREETING], { infoSignalsCount: 3 }),
        ]);
        expect(out.qualified).toBe(1);
    });
});

describe("buildCallQualityFunnel — the greeting cliff", () => {
    it("splits transcripts by whether the opening line finished", () => {
        const out = buildCallQualityFunnel([
            talked(["agent: नमस्ते sir, दो minute बात कर सकते हैं?"]),
            talked(["agent: नमस्ते sir! Priya बोल रही हूँ iTarang..."]),
            talked(["agent: नमस्ते sir! Priya बोल रही हूँ iTarang Technologies और"]),
        ]);
        expect(out.greeting.complete).toBe(1);
        expect(out.greeting.cutOff).toBe(2);
    });

    it("counts only calls where the dealer never spoke as the cliff", () => {
        // A call that got past the greeting is not part of this diagnosis even
        // if it was severed later.
        const out = buildCallQualityFunnel([
            talked(["agent: नमस्ते sir! Priya बोल रही हूँ iTarang..."]),
            talked(["agent: नमस्ते sir! Priya बोल रही हूँ iTarang...", "user: हाँ बोलिये"]),
        ]);
        expect(out.greeting.cutOffBeforeDealerSpoke).toBe(1);
    });

    it("reports the median duration of the cliff calls", () => {
        const cut = "agent: नमस्ते sir! Priya बोल रही हूँ iTarang...";
        const out = buildCallQualityFunnel([
            talked([cut], { providerDurationSeconds: 5 }),
            talked([cut], { providerDurationSeconds: 7 }),
            talked([cut], { providerDurationSeconds: 20 }),
        ]);
        expect(out.greeting.medianCutOffSeconds).toBe(7);
    });
});

describe("buildCallQualityFunnel — opening scripts", () => {
    it("groups by fingerprint and ranks by dealer reply rate", () => {
        const namaskar = "agent: नमस्कार sir, Priya बोल रही हूँ iTarang Technologies से।";
        const namaste = "agent: नमस्ते sir! Priya बोल रही हूँ iTarang Technologies से।";
        const out = buildCallQualityFunnel([
            talked([namaskar, "user: हाँ"]),
            talked([namaskar, "user: हाँ"]),
            talked([namaste]),
            talked([namaste]),
        ]);
        expect(out.openingScripts).toHaveLength(2);
        const top = out.openingScripts[0];
        expect(top.calls).toBe(2);
        expect(top.dealerSpoke).toBe(2);
    });

    it("keeps one script together however far it got before cutting out", () => {
        const out = buildCallQualityFunnel([
            talked(["agent: नमस्ते sir! Priya बोल रही हूँ iTarang Technologies से। हम"]),
            talked(["agent: नमस्ते sir! Priya बोल रही हूँ iTarang..."]),
            talked(["agent: नमस्ते sir! Priya बोल रही हूँ..."]),
        ]);
        expect(out.openingScripts).toHaveLength(1);
        expect(out.openingScripts[0].calls).toBe(3);
    });

    it("ignores calls with no transcript to fingerprint", () => {
        const out = buildCallQualityFunnel([lead({ providerDurationSeconds: 30 })]);
        expect(out.openingScripts).toEqual([]);
    });
});

describe("buildCallQualityFunnel — degenerate inputs", () => {
    it("returns all-zero rather than NaN for an empty campaign", () => {
        const out = buildCallQualityFunnel([]);
        expect(out.attempted).toBe(0);
        expect(out.answered).toBe(0);
        expect(out.withTranscript).toBe(0);
        expect(out.scored).toBe(0);
        expect(out.greeting.medianCutOffSeconds).toBeNull();
        expect(out.openingScripts).toEqual([]);
    });

    it("returns all-zero for a campaign that only has pending leads", () => {
        const out = buildCallQualityFunnel([
            lead({ status: "pending", providerDurationSeconds: null }),
        ]);
        expect(out.attempted).toBe(0);
        expect(out.dialled).toBe(0);
    });

    it("never lets a later stage exceed an earlier one", () => {
        const out = buildCallQualityFunnel([
            talked([GREETING, "user: a", "agent: q", "user: b", "agent: r", "user: c"], {
                infoSignalsCount: 5,
            }),
            lead({ status: "failed", callOutcome: "trigger_failed", providerDurationSeconds: null }),
            lead({ status: "pending", providerDurationSeconds: null }),
        ]);
        expect(out.dialled).toBeLessThanOrEqual(out.attempted);
        expect(out.answered).toBeLessThanOrEqual(out.dialled);
        expect(out.withTranscript).toBeLessThanOrEqual(out.answered);
        expect(out.dealerSpoke).toBeLessThanOrEqual(out.withTranscript);
        expect(out.pastOpener).toBeLessThanOrEqual(out.dealerSpoke);
        expect(out.meaningfulConversation).toBeLessThanOrEqual(out.pastOpener);
        expect(out.qualified).toBeLessThanOrEqual(out.scored);
    });
});

// The user asked two questions that sound alike and are not:
//   "how many hung up immediately?"          -> died DURING the greeting
//   "how many disconnected after hearing it?" -> heard it ALL, then left
// The first indicts telephony, the second indicts the script. On live data they
// are 44 and 7. Reporting only the first sends someone to rewrite the wrong
// thing, which is the failure this whole section exists to prevent.
describe("buildCallQualityFunnel — heard the whole greeting, then nothing", () => {
    const COMPLETE = "agent: नमस्ते sir, दो minute बात कर सकते हैं?";
    const CUT = "agent: नमस्ते sir! Priya बोल रही हूँ iTarang...";

    it("separates a silent dealer who heard everything from one cut off mid-sentence", () => {
        const out = buildCallQualityFunnel([
            talked([COMPLETE]), // heard it all, said nothing
            talked([CUT]), // never heard it
            talked([COMPLETE, "user: हाँ"]), // heard it and replied
        ]);
        expect(out.greeting.completeThenSilent).toBe(1);
        expect(out.greeting.cutOffBeforeDealerSpoke).toBe(1);
    });

    it("never counts a dealer who replied", () => {
        const out = buildCallQualityFunnel([talked([COMPLETE, "user: हाँ बोलिये"])]);
        expect(out.greeting.completeThenSilent).toBe(0);
    });

    it("accounts for every silent call as one or the other", () => {
        const rows = [talked([COMPLETE]), talked([CUT]), talked([CUT]), talked([COMPLETE, "user: a"])];
        const out = buildCallQualityFunnel(rows);
        const silent = out.withTranscript - out.dealerSpoke;
        expect(out.greeting.completeThenSilent + out.greeting.cutOffBeforeDealerSpoke).toBe(silent);
    });
});

describe("buildCallQualityFunnel — response time before hang-up", () => {
    const turns = (t: Array<{ speaker: string; text: string; at?: number }>) =>
        t.map((x) => ({ role: x.speaker, message: x.text, time_in_call_secs: x.at }));

    it("reports no timings available when nothing carries them", () => {
        const out = buildCallQualityFunnel([
            talked(["agent: नमस्ते sir, बात कर सकते हैं?"], { providerDurationSeconds: 9 }),
        ]);
        expect(out.responseTime.measured).toBe(0);
        expect(out.responseTime.medianSecondsBeforeHangUp).toBeNull();
    });

    it("measures from the AI's last turn to the end of a call the dealer never answered", () => {
        const out = buildCallQualityFunnel([
            {
                ...lead({ providerDurationSeconds: 12 }),
                transcript: "agent: नमस्ते sir, बात कर सकते हैं?",
                transcriptTurns: turns([{ speaker: "agent", text: "नमस्ते sir", at: 2 }]),
            },
        ]);
        // Greeting starts at 2s, call ends at 12s -> the dealer stayed 10s.
        expect(out.responseTime.measured).toBe(1);
        expect(out.responseTime.medianSecondsBeforeHangUp).toBe(10);
    });

    it("ignores calls where the dealer did reply — that is not a hang-up", () => {
        const out = buildCallQualityFunnel([
            {
                ...lead({ providerDurationSeconds: 30 }),
                transcript: "agent: hi\nuser: haan",
                transcriptTurns: turns([
                    { speaker: "agent", text: "hi", at: 1 },
                    { speaker: "user", text: "haan", at: 6 },
                ]),
            },
        ]);
        expect(out.responseTime.measured).toBe(0);
    });

    it("ignores a turn array with no usable timing", () => {
        const out = buildCallQualityFunnel([
            {
                ...lead({ providerDurationSeconds: 12 }),
                transcript: "agent: hi",
                transcriptTurns: [{ role: "agent", message: "hi" }],
            },
        ]);
        expect(out.responseTime.measured).toBe(0);
    });

    it("refuses a negative interval rather than reporting a nonsense median", () => {
        const out = buildCallQualityFunnel([
            {
                ...lead({ providerDurationSeconds: 5 }),
                transcript: "agent: hi",
                transcriptTurns: turns([{ speaker: "agent", text: "hi", at: 40 }]),
            },
        ]);
        expect(out.responseTime.measured).toBe(0);
    });
});

// "Average conversation duration" was being answered with a mean over ALL
// measured calls, which on live data is 32s — a blend of 52s conversations and
// 9s calls where nobody spoke. Every other number on this panel states its own
// population; this one did not, and it was the one that predated the funnel.
describe("buildCallQualityFunnel — conversation duration", () => {
    const spoke = (secs: number) =>
        talked([GREETING, "user: हाँ बोलिये"], { providerDurationSeconds: secs });
    const silent = (secs: number) => talked([GREETING], { providerDurationSeconds: secs });

    it("averages only the calls where the dealer actually spoke", () => {
        const out = buildCallQualityFunnel([spoke(40), spoke(60), silent(6), silent(8)]);
        expect(out.conversation.measured).toBe(2);
        expect(out.conversation.averageSeconds).toBe(50);
    });

    it("reports a median alongside the mean, which the long tail drags", () => {
        const out = buildCallQualityFunnel([spoke(10), spoke(20), spoke(300)]);
        expect(out.conversation.medianSeconds).toBe(20);
        expect(out.conversation.averageSeconds).toBe(110);
    });

    it("ignores a conversation with no usable duration", () => {
        const out = buildCallQualityFunnel([
            spoke(30),
            talked([GREETING, "user: हाँ"], { providerDurationSeconds: null }),
        ]);
        expect(out.conversation.measured).toBe(1);
        expect(out.conversation.averageSeconds).toBe(30);
    });

    it("is null rather than zero when no conversation happened", () => {
        const out = buildCallQualityFunnel([silent(7), silent(9)]);
        expect(out.conversation.measured).toBe(0);
        expect(out.conversation.averageSeconds).toBeNull();
        expect(out.conversation.medianSeconds).toBeNull();
    });

    it("never counts more conversations than dealers who spoke", () => {
        const out = buildCallQualityFunnel([spoke(30), spoke(40), silent(5)]);
        expect(out.conversation.measured).toBeLessThanOrEqual(out.dealerSpoke);
    });
});
