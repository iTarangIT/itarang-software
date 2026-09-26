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
    EARLY_HANGUP_SECS,
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

describe("answered, but the dealer never spoke → silent / hung_up", () => {
    it("the AI greeted a line where the dealer listened and said nothing", () => {
        // THE inflation: 481 rows on prod were this shape and read "Completed".
        expect(
            classifyCallEnd({ providerStatus: "done", transcript: agent, durationSecs: 35 }).status,
        ).toBe("silent");
    });

    it("the dealer cut the greeting off", () => {
        expect(
            classifyCallEnd({ providerStatus: "done", transcript: agent, durationSecs: 4 }).status,
        ).toBe("hung_up");
        expect(
            classifyCallEnd({
                providerStatus: "done",
                transcript: agent,
                durationSecs: EARLY_HANGUP_SECS - 1,
            }).status,
        ).toBe("hung_up");
        expect(
            classifyCallEnd({
                providerStatus: "done",
                transcript: agent,
                durationSecs: EARLY_HANGUP_SECS,
            }).status,
        ).toBe("silent");
    });

    it("with no duration, only a remote-hangup reason says early", () => {
        expect(classifyCallEnd({ providerStatus: "done", transcript: agent }).status).toBe(
            "silent",
        );
        expect(
            classifyCallEnd({
                transcript: agent,
                terminationReason: "Call ended by remote party",
            }).status,
        ).toBe("hung_up");
        expect(
            classifyCallEnd({ transcript: agent, terminationReason: "user_hangup" }).status,
        ).toBe("hung_up");
    });

    it("a dealer turn with no words in it is not speech", () => {
        for (const noise of ["user: ...", "user: …", "user:"]) {
            expect(
                classifyCallEnd({
                    providerStatus: "done",
                    transcript: `${agent}\n${noise}`,
                    durationSecs: 20,
                }).status,
                noise,
            ).toBe("silent");
            expect(
                classifyCallEnd({
                    providerStatus: "done",
                    transcript: `${agent}\n${noise}`,
                    durationSecs: 3,
                }).status,
                noise,
            ).toBe("hung_up");
        }
    });

    it("'completed' with nothing exchanged and 0 seconds never connected", () => {
        // ElevenLabs defaults a missing status to "completed".
        expect(classifyCallEnd({ providerStatus: "completed" }).status).toBe("no_response");
        expect(classifyCallEnd({ providerStatus: "completed", durationSecs: 0 }).status).toBe(
            "no_response",
        );
        expect(
            classifyCallEnd({ providerStatus: "done", transcript: "", durationSecs: "0" }).status,
        ).toBe("no_response");
    });

    it("'completed' with nothing exchanged but an open line is silent / hung up", () => {
        expect(classifyCallEnd({ providerStatus: "completed", durationSecs: 20 }).status).toBe(
            "silent",
        );
        expect(classifyCallEnd({ providerStatus: "completed", durationSecs: 3 }).status).toBe(
            "hung_up",
        );
    });

    it("never writes the legacy no_conversation bucket", () => {
        const inputs = [
            { transcript: agent },
            { transcript: agent, durationSecs: 2 },
            { providerStatus: "completed" },
            { providerStatus: "done", durationSecs: 50 },
            { transcript: agent, initiationFailureReason: "unknown" },
        ];
        for (const e of inputs) expect(classifyCallEnd(e).status).not.toBe("no_conversation");
    });

    it("labels: Silent Call / Hung Up Early, the queue reads Queued, nothing reads Pending", () => {
        expect(CAMPAIGN_LEAD_STATUS_LABELS.silent).toBe("Silent Call");
        expect(CAMPAIGN_LEAD_STATUS_LABELS.hung_up).toBe("Hung Up Early");
        expect(CAMPAIGN_LEAD_STATUS_LABELS.pending).toBe("Queued");
        expect(Object.values(CAMPAIGN_LEAD_STATUS_LABELS)).not.toContain("Pending");
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
        ).toBe("silent");
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

    it("the inflated 'completed' row: AI greeted, dealer silent → silent", () => {
        expect(
            reclassifyStoredAttempt({
                status: "completed",
                callOutcome: "dropped_empty",
                transcript: agent,
                providerStatus: "done",
                durationSecs: 40,
            })?.status,
        ).toBe("silent");
    });

    it("splits a legacy no_conversation row by duration and end reason", () => {
        const legacy = {
            status: "no_conversation",
            callOutcome: "dropped_empty",
            transcript: agent,
            providerStatus: "done",
        };
        expect(reclassifyStoredAttempt({ ...legacy, durationSecs: 3 })?.status).toBe("hung_up");
        expect(reclassifyStoredAttempt({ ...legacy, durationSecs: 45 })?.status).toBe("silent");
        expect(
            reclassifyStoredAttempt({ ...legacy, endReason: "client disconnected" })?.status,
        ).toBe("hung_up");
        // No log row, no transcript, "completed" as the outcome: never connected.
        expect(
            reclassifyStoredAttempt({
                status: "no_conversation",
                callOutcome: "completed",
                transcript: null,
                providerStatus: null,
            })?.status,
        ).toBe("no_response");
    });

    it("re-classifying a split row is a no-op", () => {
        const row = { callOutcome: "dropped_empty", transcript: agent, providerStatus: "done" };
        for (const [status, durationSecs] of [
            ["silent", 30],
            ["hung_up", 2],
        ] as const) {
            expect(reclassifyStoredAttempt({ ...row, status, durationSecs })?.status).toBe(status);
        }
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

// Prod, camp_msr9dbh0_gwn04wcq (Bhopal retry, 2026-08-13): 12 of its 21
// "Completed" calls were a machine answering — an auto-reply, a call-screening
// assistant or an IVR menu — and the Voicemail card read 0. None of these
// carries the carrier "number you have dialled" frame, so they were all read as
// the dealer speaking. Every dealer-side text below is verbatim from that
// campaign.
describe("calibration — a machine answered, not the dealer", () => {
    const machineOnly: [string, string[]][] = [
        ["auto-reply", ["Your call went unanswered. We have noted your number. You will receive a call back shortly."]],
        ["auto-reply after silence", ["...", "Your call went unanswered. We have noted your number. You will receive a call back shortly."]],
        ["call screening", ["Thanks, please stay on the line."]],
        ["call screening, then silence", ["Thanks, please stay on the line.", "...", "..."]],
        ["call screening after silence", ["...", "Please stay on the line."]],
        ["call screening (sandbox)", ["See if the person is available.", "Please stay on the line.", "..."]],
        ["IVR no-input prompt", ["क्षमा करें, हमें कोई input प्राप्त नहीं हुआ। कृपया फिर से try करें।फिर से try क"]],
        ["IVR language menu", ["Select any option, press 1 for English. हिंदी के लिए 2 दबाइए।", "You didn't select any option."]],
        [
            "IVR sales/service menu",
            [
                "You didn't select any option. Welcome to Tata Motors. For sales, press 1. For service, press 2. Tata Motors में आपका स्वागत है। Sales के लिए 1 दबाएँ। Service के लिए 2 दबाएँ।",
                "You didn't select any option. This call may be recorded for call training and quality purposes.",
            ],
        ],
        [
            "IVR voice menu",
            [
                "Please confirm the language, press 1 for English. हिंदी के लिए 2 दबाएँ।",
                "नई गाड़ी खरीदने के लिए कहें, sales, नई गाड़ी खरीदें। गाड़ी की service करवाने के लिए कहें, service, गाड़ी की service करवाएँ।",
            ],
        ],
        [
            "IVR hold message",
            ["Your call is important to us. Our sales executive will attend to you shortly. This call... हैलो?"],
        ],
        // The rest are from other prod campaigns, same review (2026-09-22).
        [
            "call assistant",
            ["Hi, I am a call assistant recording this call for the person you are trying to reach. Please say who you are and why you are calling."],
        ],
        ["screening, 'reason for calling'", ["Hi, if you record your name and reason for calling, I'll see if this person is available."]],
        [
            "store hold message",
            ["Thanks for calling Aditya Visions. This call will be recorded for quality and marketing purposes. Please wait while we are connecting your call with the store manager."],
        ],
        ["recording notice alone", ["This call is now being recorded."]],
        [
            "Hindi IVR, keys as words",
            ["यह call quality और marketing purposes के लिए record की जा सकती है। Sales से जुड़ी जानकारी के लिए एक दबाएँ। Service से जुड़ी जानकारी के लिए दो दबाएँ।"],
        ],
        ["English IVR, key as a word", ["Press one.", "हिंदी के लिए दो दबाइए।", "You didn't select any option."]],
        [
            "IVR, then transfer in Latin-script Hindi",
            [
                "Please confirm the language, press 1 for English. हिंदी के लिए 2 दबाएँ।",
                "नई गाड़ी खरीदने के लिए कहें। सिर्फ़ एक बार। Sales, गाड़ी की service करवाने के लिए कहें। Service, कोई और सहायता के लिए कहें। अन्य।",
                "कृपया line पर बने रहें।हम आपकी call customer executive को transfer कर रहे हैं।",
            ],
        ],
        [
            "dealership transfer message",
            ["Hello, thank you for calling to Maruti Suzuki authorized dealership. We are transferring your call to our team of experienced agents. Someone will be with you shortly."],
        ],
    ];

    for (const [name, userTurns] of machineOnly) {
        it(`${name} → voicemail`, () => {
            const transcript = [agent, ...userTurns.map((t) => `user: ${t}`)].join("\n");
            expect(dealerSpoke(transcript)).toBe(false);
            expect(classifyCallEnd({ providerStatus: "done", transcript }).status).toBe("voicemail");
        });
    }

    // Same campaign: a person picked up after the machine. That IS a
    // conversation, and must stay Completed.
    const humanAfterMachine: [string, string[]][] = [
        ["screening, then the dealer", ["Thanks. Please stay on the line.", "...", "Hello?"]],
        ["screening, then a real exchange", ["Thanks. Please stay on the line.", "...", "Hello?", "क्या बात करनी है?"]],
        [
            "transfer message, then a person",
            [
                "Call is being transferred to a customer care executive and may be recorded for quality and training purposes. Your call is being... नमस्ते sir, आप कैसे हो? How can I help you?",
                "Hello?",
            ],
        ],
        [
            "hold message, then a person",
            [
                "Your call is important to us. Our sales executive will attend to you shortly. नमस्कार, मेरा नाम प्रभात है।",
                "कौन सी भाई?",
            ],
        ],
        ["store greeting, then a person", ["Thank you for calling Awadh Battery & Electronics Centre. Your call will be answered shortly.", "Hello?"]],
        ["screening, then 'haan'", ["Hi, if you record your reason for this person is available.", "हाँ।"]],
    ];

    for (const [name, userTurns] of humanAfterMachine) {
        it(`${name} → completed`, () => {
            const transcript = [agent, ...userTurns.map((t) => `user: ${t}`)].join("\n");
            expect(dealerSpoke(transcript)).toBe(true);
            expect(classifyCallEnd({ providerStatus: "done", transcript }).status).toBe("completed");
        });
    }

    // The machine phrases must not swallow a dealer. Each of these is a person.
    it("does not mistake a dealer for a machine", () => {
        for (const said of [
            "एक minute, line पे रहिए",
            "ruko, hold karo",
            "main aapko call back karunga",
            "haan, press karke dekho",
            "Express battery ka dealer hoon, 1 saal se",
            "sales ke liye mere bhai se baat karo",
            "option kya hai EMI ka?",
            "मैं बाद में बात करूँगा",
            "दो battery चाहिए, दाम बताओ",
            "haan, recording chal rahi hai kya?",
            "wo person abhi available nahi hai",
        ]) {
            const transcript = `${agent}\nuser: ${said}`;
            expect(dealerSpoke(transcript), said).toBe(true);
            expect(classifyCarrierAnnouncement(said), said).toBeNull();
        }
    });

    // A machine that says "busy" is still a machine. Only the carrier frame
    // decides busy / no-response / invalid.
    it("an IVR hold saying 'busy' is a machine, not a busy line", () => {
        expect(
            classifyCarrierAnnouncement(
                "All our executives are busy. Your call is important to us, please stay on the line.",
            ),
        ).toBe("voicemail");
    });

    it("a carrier call-waiting message stays busy", () => {
        expect(
            classifyCarrierAnnouncement(
                "The number you are calling is busy on another call, please stay on the line or call later.",
            ),
        ).toBe("busy");
    });

    it("the machine phrases reach the SQL twin", () => {
        const s = dealerSpokeSql("acl");
        expect(s).toContain("your call went unanswered");
        expect(s).toContain("press ([0-9]|one|");
    });
});
