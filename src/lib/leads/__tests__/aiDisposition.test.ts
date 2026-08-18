// Tests for the AI-call → L1/L2/L3 disposition mapper.
//
// The valuable assertions here are the INVARIANTS, generated over the whole
// cross-product of inputs, not a re-typing of the rule table (a diff would show
// that, and a hand-copied expectation just encodes the same mistake twice):
//
//   1. it never invents a label — every non-null output is in the sheet
//   2. it round-trips through classifyDisposition, so a typo or a bucket that
//      contradicts the sheet fails here rather than in production data
//   3. the connect gate is absolute in both directions
//   4. call_status always agrees with the L3 it was derived from
//   5. every declared reason code is reachable — a dead branch fails the test
//
// Plus the named regressions, one per rule, which are the cases a reader will
// want to check by eye.

import { describe, expect, it } from "vitest";
import {
    aiExternalTag,
    mapAiCallToDisposition,
    type AiCallDispositionInput,
    type AiDispositionReason,
} from "@/lib/leads/aiDisposition";
import {
    ALL_CONNECTED_DISPOSITIONS,
    callStatusForDisposition,
    classifyDisposition,
    NOT_CONNECTED_REASONS,
} from "@/lib/leads/dispositions";
import { CALL_STATUS } from "@/lib/lifecycle/touchpointTypes";
import { DISQUALIFIERS } from "@/lib/ai/scoring/signals";

const BANDS = ["Qualified", "Warm", "Cold", "Disqualified", null] as const;
const BAND_CALL_STATUSES = [
    "complete",
    "dropped_partial",
    "dropped_empty",
    null,
] as const;

const PROVIDER_STATUSES = [
    "no_answer",
    "no-answer",
    "NO ANSWER",
    "voicemail",
    "machine_detected",
    "busy",
    "user_busy",
    "rejected",
    "declined",
    "invalid_number",
    "wrong_number",
    "switched_off",
    "power_off",
    "unreachable",
    "out_of_coverage",
    "network_error",
    "failed",
    "error",
    "call-disconnected",
    "completed",
    "done",
    "canceled",
    "cancelled",
    "stopped",
    "",
    "  ",
    "something_nobody_has_seen",
    "🙂",
    "ringing",
    "in-progress",
];

/** Every input combination the mapper can be handed. */
function* allInputs(): Generator<AiCallDispositionInput> {
    // Not connected: only the provider status matters, but vary the rest to
    // prove it genuinely does not leak into the result.
    for (const providerStatus of PROVIDER_STATUSES) {
        for (const transcript of [null, "", "   "]) {
            yield { transcript, providerStatus, band: "Qualified", infoSignalsCount: 5 };
        }
    }

    // Connected: the full cross-product of everything the band engine produces.
    for (const band of BANDS) {
        for (const bandCallStatus of BAND_CALL_STATUSES) {
            for (const disqualifier of DISQUALIFIERS) {
                for (const infoSignalsCount of [0, 1, 2, 3, 4, 5]) {
                    for (const callbackAgreed of [true, false, null]) {
                        for (const relevantDealer of [true, false, null]) {
                            for (const pitchHeard of [true, false, null]) {
                                for (const analysisFailed of [true, false]) {
                                    yield {
                                        transcript: "Agent: hello\nUser: haan",
                                        providerStatus: "completed",
                                        analysisFailed,
                                        band,
                                        bandCallStatus,
                                        infoSignalsCount,
                                        disqualifier,
                                        callbackAgreed,
                                        relevantDealer,
                                        pitchHeard,
                                    };
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

const KNOWN_LABELS = new Set<string>([
    ...ALL_CONNECTED_DISPOSITIONS,
    ...NOT_CONNECTED_REASONS,
]);

describe("mapAiCallToDisposition — invariants over every input", () => {
    // THE assertion that matters. "Do not invent labels" is enforced
    // mechanically rather than by review, so a future rule that reaches for a
    // plausible-sounding string fails here.
    it("never emits a label outside the CC sheet", () => {
        for (const input of allInputs()) {
            const out = mapAiCallToDisposition(input);
            if (out.disposition !== null) {
                expect(
                    KNOWN_LABELS.has(out.disposition),
                    `invented label: ${out.disposition}`,
                ).toBe(true);
            }
        }
    });

    it("round-trips through classifyDisposition without contradicting it", () => {
        for (const input of allInputs()) {
            const out = mapAiCallToDisposition(input);
            if (out.disposition === null) continue;
            const classified = classifyDisposition(out.disposition, {
                callConnected: out.connectStatus === "connected",
            });
            expect(classified?.isKnown, `unknown: ${out.disposition}`).toBe(true);
            expect(classified?.connectStatus).toBe(out.connectStatus);
            // The mapper may pick a bucket the classifier would settle
            // differently ONLY for a label in two buckets. Nothing it emits is.
            expect(classified?.bucket).toBe(out.bucket);
        }
    });

    it("treats the transcript as the absolute connect gate", () => {
        for (const input of allInputs()) {
            const out = mapAiCallToDisposition(input);
            const hasTranscript = Boolean(
                input.transcript && input.transcript.trim() !== "",
            );
            expect(out.connectStatus).toBe(
                hasTranscript ? "connected" : "not_connected",
            );
        }
    });

    it("only ever emits a real touchpoint call_status", () => {
        for (const input of allInputs()) {
            const out = mapAiCallToDisposition(input);
            expect((CALL_STATUS as readonly string[]).includes(out.callStatus)).toBe(
                true,
            );
        }
    });

    it("keeps call_status consistent with the label it derived it from", () => {
        for (const input of allInputs()) {
            const out = mapAiCallToDisposition(input);
            if (out.disposition === null) {
                // No label to derive from — connected calls with no honest L3.
                expect(out.callStatus).toBe("connected");
                continue;
            }
            const expected =
                callStatusForDisposition(
                    classifyDisposition(out.disposition, {
                        callConnected: out.connectStatus === "connected",
                    }),
                ) ?? "not_responding";
            expect(out.callStatus).toBe(expected);
        }
    });

    it("gives a not-connected call no bucket", () => {
        for (const input of allInputs()) {
            const out = mapAiCallToDisposition(input);
            if (out.connectStatus === "not_connected") {
                expect(out.bucket).toBeNull();
            }
        }
    });

    // A dead branch is a rule nobody can reach — usually because an earlier
    // rule subsumes it. This catches that at the point it is introduced.
    it("can reach every declared reason code", () => {
        const seen = new Set<AiDispositionReason>();
        for (const input of allInputs()) seen.add(mapAiCallToDisposition(input).reasonCode);

        const declared: AiDispositionReason[] = [
            "nc:no_answer",
            "nc:busy",
            "nc:rejected",
            "nc:invalid_number",
            "nc:switched_off",
            "nc:unreachable",
            "nc:failed",
            "nc:unknown",
            "c:analysis_failed",
            "c:not_analysed",
            "c:dropped_empty",
            "c:irrelevant",
            "c:disqualified",
            "c:callback_only",
            "c:substance",
            "c:short_hangup",
            "c:no_disclosure",
        ];
        for (const r of declared) {
            expect(seen.has(r), `unreachable rule: ${r}`).toBe(true);
        }
        expect(seen.size).toBe(declared.length);
    });

    // "Commercials Explained" is the one label in two buckets. The AI must never
    // produce it — there would be no user to ask which bucket was meant, and it
    // would silently default to Warm and make the Hot filter under-count.
    it("never produces the ambiguous two-bucket label", () => {
        for (const input of allInputs()) {
            expect(mapAiCallToDisposition(input).disposition).not.toBe(
                "Commercials Explained",
            );
        }
    });
});

describe("mapAiCallToDisposition — named cases", () => {
    const connected = (over: Partial<AiCallDispositionInput> = {}) =>
        mapAiCallToDisposition({
            transcript: "Agent: hello\nUser: haan",
            providerStatus: "completed",
            bandCallStatus: "complete",
            infoSignalsCount: 0,
            disqualifier: "none",
            callbackAgreed: false,
            relevantDealer: true,
            pitchHeard: true,
            ...over,
        });

    it("no answer → Did not pick", () => {
        const out = mapAiCallToDisposition({
            transcript: null,
            providerStatus: "no_answer",
        });
        expect(out).toMatchObject({
            connectStatus: "not_connected",
            disposition: "Did not pick",
            callStatus: "not_responding",
        });
    });

    it("a provider 'completed' with no transcript is not a connect", () => {
        const out = mapAiCallToDisposition({
            transcript: null,
            providerStatus: "completed",
        });
        expect(out.connectStatus).toBe("not_connected");
        expect(out.disposition).toBe("Call not connected / can not be completed");
    });

    it("invalid number → its own call status", () => {
        expect(
            mapAiCallToDisposition({ transcript: null, providerStatus: "wrong_number" })
                .callStatus,
        ).toBe("incorrect_number");
    });

    it("dropped_empty → Cold / Short Hang up", () => {
        expect(connected({ bandCallStatus: "dropped_empty", band: null })).toMatchObject(
            { bucket: "Cold", disposition: "Short Hang up" },
        );
    });

    it("an irrelevant dealer is Lost, and beats the disqualifier", () => {
        expect(
            connected({ relevantDealer: false, disqualifier: "not_interested" }),
        ).toMatchObject({ bucket: "Lost", disposition: "Some other Business" });
    });

    it("a hard disqualifier → Lost / Not Interested", () => {
        for (const d of ["not_interested", "dont_call", "hostile"] as const) {
            expect(connected({ disqualifier: d })).toMatchObject({
                bucket: "Lost",
                disposition: "Not Interested",
            });
        }
    });

    it("callback with nothing disclosed → Cold / As to Call Back", () => {
        expect(connected({ callbackAgreed: true, infoSignalsCount: 0 })).toMatchObject({
            bucket: "Cold",
            disposition: "As to Call Back",
        });
    });

    // The refinement over the literal "callback_agreed → As to Call Back" rule.
    it("callback WITH substance → Warm / Information Collected", () => {
        expect(connected({ callbackAgreed: true, infoSignalsCount: 2 })).toMatchObject({
            bucket: "Warm",
            disposition: "Information Collected",
        });
    });

    // An AI call cannot reach the sheet's Hot bucket — every Hot label names a
    // commercial artefact only a human produces.
    it("a Qualified band still lands in Warm", () => {
        expect(
            connected({ band: "Qualified", infoSignalsCount: 4 }),
        ).toMatchObject({ bucket: "Warm", disposition: "Information Collected" });
    });

    it("analysis failure is connected with no label", () => {
        const out = connected({ analysisFailed: true, infoSignalsCount: 3 });
        expect(out.connectStatus).toBe("connected");
        expect(out.disposition).toBeNull();
        expect(out.bucket).toBeNull();
    });

    // A transcript with no analysis at all is NOT a claim about the dealer.
    it("an unanalysed call is reported as unanalysed, not as silence", () => {
        const out = mapAiCallToDisposition({
            transcript: "Agent: hello\nUser: haan",
            providerStatus: "completed",
            band: null,
            bandCallStatus: null,
            infoSignalsCount: null,
            disqualifier: null,
            callbackAgreed: null,
            relevantDealer: null,
            pitchHeard: null,
        });
        expect(out.connectStatus).toBe("connected");
        expect(out.disposition).toBeNull();
        expect(out.reasonCode).toBe("c:not_analysed");
    });

    it("pitch heard, nothing disclosed, nothing refused → no honest label", () => {
        const out = connected({ pitchHeard: true, infoSignalsCount: 0 });
        expect(out.disposition).toBeNull();
        expect(out.reasonCode).toBe("c:no_disclosure");
    });

    it("pitch NOT heard, nothing disclosed → Short Hang up", () => {
        expect(connected({ pitchHeard: false, infoSignalsCount: 0 })).toMatchObject({
            disposition: "Short Hang up",
            bucket: "Cold",
        });
    });
});

describe("aiExternalTag", () => {
    it("carries the band the L2 bucket cannot", () => {
        expect(
            aiExternalTag({ transcript: "x", providerStatus: "completed", band: "Qualified" }),
        ).toBe("Qualified");
    });

    it("falls back to the call status, then to needs_review", () => {
        expect(
            aiExternalTag({
                transcript: "x",
                providerStatus: "completed",
                band: null,
                bandCallStatus: "dropped_empty",
            }),
        ).toBe("dropped_empty");
        expect(
            aiExternalTag({ transcript: "x", providerStatus: "c", analysisFailed: true }),
        ).toBe("needs_review");
    });
});
