# AI-dialer call-quality funnel — design

**Date:** 2026-08-24
**Status:** approved, implementing
**Phase 1 (shipped, separate):** the duration-histogram correctness fix — see
`src/lib/ai-dialer/call-duration/derive.ts` and `drizzle/E-266_recompute_campaign_calls_made.sql`.

## The question this answers

The campaign screen's Call Quality panel showed a duration histogram whose
denominator (146 "measured calls") contradicted the Completed card (71). Phase 1
fixed that. Phase 2 answers the question underneath it: **where in the call are
we losing dealers, and which opening line loses fewest?**

## What the data actually says

Measured on database-1 (sandbox), 2026-08-24. 298 `ai_call_logs` rows, 83 with a
transcript (28%).

Funnel over the transcript subset:

| Stage                          | n  | share |
|--------------------------------|----|-------|
| Greeting delivered             | 83 | 100%  |
| Dealer said anything           | 32 | 39%   |
| AI got a 2nd turn              | 26 | 31%   |
| >=3 dealer turns               | 11 | 13%   |

**The headline is not in that table.** 51 of 83 transcripts are a SINGLE turn —
the agent speaks, the dealer never does. Of those 51:

```
greeting CUT OFF mid-sentence : 44
greeting COMPLETE             :  7
duration median 7s (range 3-20s)
```

So "how many disconnected after hearing the greeting?" has the answer **almost
nobody hears the greeting**: 44 of 83 connected calls (53%) end inside the
opening sentence at a median of 7 seconds. A funnel phrased as
"% reaching the first question" hides this behind a single low percentage.

Opening-line comparison, same data:

| Opener (prefix)                                  | n  | avg dur | dealer replied |
|--------------------------------------------------|----|---------|----------------|
| `नमस्कार sir, Priya बोल रही हूँ iTarang…`            |  5 | 47s     | 80%            |
| `नमस्कार sir, … E-ri…`                             |  5 | 46s     | 60%            |
| `नमस्ते sir! … Technologies से। हम Tr…`             | 49 | 21s     | 37%            |
| `नमस्ते sir! … हम…`                                |  5 |  6s     | 0%             |

`नमस्कार` beats `नमस्ते` on both axes. Small n, large effect — surfaced with the
caveat attached, never as a verdict.

## Decisions taken (with the user, before implementation)

1. **Framing** — lead with the mid-greeting cliff; the nine-question funnel sits
   below it as the detailed breakdown. Answers everything asked, actionable
   number first.
2. **Coverage** — honest split denominators. Duration-based stages run on all
   calls; transcript-based stages state their own denominator; qualification
   states a THIRD. Never one number pretending to cover everything.
3. **Script comparison** — fingerprint the opening line. `agent_id` cannot serve:
   it is populated on 206 rows and on ZERO of the 83 with transcripts.
4. **Turn timings** — persist going forward (see E-266 below); the metric stays
   dark and honestly labelled until data accrues.
5. **Placement** — extend the existing Call Quality panel.

## Architecture

### Parse on read, not denormalised columns

The whole table is ~300 rows / 83 transcripts of 335-1,500 chars: the aggregate
is a two-page scan. Precomputing `turn_count` / `greeting_complete` /
`opening_fingerprint` into columns would buy nothing and cost a migration PLUS a
re-backfill every time a heuristic is tuned — and these heuristics WILL be tuned,
because "did the greeting finish" is a judgement call. Parse-on-read means fixing
the parser retroactively corrects all history.

Same reasoning E-249 already recorded for a GIN on `signals`: "would index 27
documents to accelerate a two-page scan and would never be planned. Revisit at
~50k rows." **Revisit this decision at ~50k `ai_call_logs` rows.**

### Modules

`src/lib/ai-dialer/call-quality/transcript.ts` — pure, no db import:

```
parseTranscriptTurns(text)  -> Turn[] { speaker, text }
greetingState(turns)        -> "complete" | "cut_off" | "absent"
openingFingerprint(turns)   -> stable short key
```

The stringify contract it inverts lives in `elevenlabs/getCallStatus.ts` and
`elevenlabs/webhookHandler.ts`: one line per turn, `"<speaker>: <message>"`,
joined by `\n`, speaker being `user` / `agent` / the raw role lowercased.

CONTINUATION-SAFE: a line with no `^(agent|user):` prefix appends to the previous
turn. A turn's message is only `.trim()`ed, so an embedded newline would
otherwise read as a phantom turn. Measured 0 such lines today — the guard is for
the case that has not happened yet, not for one that has.

FINGERPRINT LENGTH IS LOAD-BEARING. At 60 chars the 83 transcripts yield 9
"variants"; at 20 chars, 4. The extra 5 are ONE script truncated at different
points — the long key was measuring where the audio stopped, not which script
ran. Script identity and truncation are orthogonal dimensions and stay separate.

`src/lib/ai-dialer/call-quality/funnel.ts` — pure. Seven stages, three
denominators:

| Stage                        | Population        | Source                                |
|------------------------------|-------------------|---------------------------------------|
| Attempted                    | all leads         | `status <> 'pending'`                 |
| Dialled (reached network)    | all leads         | not `trigger_failed` / `config_error` |
| Answered                     | all leads         | `isCallConnected` (Phase 1's rule)    |
| Dealer spoke                 | transcript subset | >=1 `user` turn                       |
| Past the opener              | transcript subset | >=2 `agent` turns                     |
| Qualified                    | **scored subset** | `info_signals_count >= 3`             |
| Meaningful conversation      | transcript subset | >=3 `user` turns                      |

Qualification gets its own third denominator deliberately: it is scored on 6 of
298 rows, so folding it into the transcript subset renders it as ~0% and reads as
"our calls never qualify" rather than "we almost never score them".

### The greeting cliff

Of answered calls with a transcript, split by `greetingState`, cross-referenced
with `deriveFailureReason` so a dropped line is not reported as a dealer hang-up.

Labelled **"the greeting did not finish"**, NOT "the dealer hung up". The
transcript proves truncation; it does not prove cause. Overclaiming here would
point the team at the script when the problem may be telephony.

### E-266 — `ai_call_logs.transcript_turns jsonb`

The one thing needing schema, because the data does not exist anywhere today.
Both ElevenLabs stringify paths currently DISCARD `time_in_call_secs` at the
`"<speaker>: <message>"` step.

- Nullable, additive, no backfill — historical timings are unrecoverable.
- Stores the turns array VERBATIM. The parser prefers jsonb when present and
  falls back to string parsing when absent, so the 83 historical transcripts keep
  working unchanged.
- The string `transcript` column stays as-is: it is read by the drawer, the
  export, the analysis prompt and the scoring harness, and rewriting those is not
  this change.
- Bolna's legacy path is untouched (2 calls).

⚠ **UNVERIFIED ASSUMPTION, deliberately made harmless.** `time_in_call_secs` is
optional in our own `ElevenLabsTranscriptTurn` type, is never read anywhere, and
no raw payload is stored — so it could not be checked offline. The design does
NOT depend on it: turns are stored verbatim, and the response-time metric renders
only when timings actually arrive, labelled "collecting" until then. If
ElevenLabs never sends them, that one tile stays dark and everything else works.
Implementation must log whether timings arrived on the first live call rather
than assuming.

### API and UI

ONE endpoint, extended: `duration-histogram` grows a `funnel` block rather than
gaining a sibling. Two endpoints would mean two independent definitions of
"connected" that could disagree — the exact failure Phase 1 just fixed. The
funnel query pulls transcripts only for connected leads (~28% of rows).

UI: three sections inside the existing `CallDurationPanel`, above the histogram —
cliff, funnel, script table. Existing fetch, cache and 10s refetch reused.

## Testing

Vitest on both pure modules:
- parser: continuation lines, unknown speakers, empty transcript, single turn,
  truncation detection, fingerprint stability across truncation points;
- funnel: all three zero-denominator cases, monotonicity, the
  transcript-subset-never-exceeds-answered invariant.

`scripts/verify-call-quality-funnel.ts` (promoted from the throwaway probe) then
asserts the same invariants against live data, in the house `verify-*` style:
imports the real modules rather than restating them.

## Known weakest points

1. **The greeting-truncation heuristic** is punctuation-based and will misfire on
   a transcript that legitimately ends without terminal punctuation. It is a
   heuristic presented as a heuristic; the UI wording must not imply certainty.
2. **`time_in_call_secs`** unverified — see above. Made non-blocking by design.
3. **Small n on script comparison.** 4 script families, the largest n=49 and
   several at n=5. Percentages are suppressed below n=5 (reusing the panel's
   existing `MIN_N_FOR_PERCENT`), but even above it these are indicative, not
   conclusive.
