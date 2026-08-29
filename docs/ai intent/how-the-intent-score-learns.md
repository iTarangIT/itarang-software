# How the AI Intent Band Works — and How It Learns

A plain-English guide. No code knowledge needed.

---

## 1. What the band is

After every AI sales call the lead gets a **band**:
**Qualified / Warm / Cold / Disqualified**, and a matching number
(90 / 60 / 30 / 0) carried in the intent score so every existing filter and
queue keeps working.

> **Note if you read the old version of this page.** It described a "0–100
> score" built from weighted BANT points (Need = 30 pts, Budget = 25 …) and told
> you to run `npm run intent:tune-weights`. That model was retired. There are no
> weights any more, the tuning script has been deleted, and the band is decided
> by a fixed rule, not by arithmetic on points.

---

## 2. How the band is decided (the two steps)

The band is NOT one big guess by the AI. It is built in two clean steps:

**Step A — the AI reads the call.**
It reports only *facts the dealer actually stated*, as yes/no answers: did he
share a battery spec? A monthly volume? Name a financier? Say he needs
financing? Agree financing would help? Agree to a callback?

**Step B — a fixed rule turns those facts into a band.**

| Condition (top rule wins) | Band |
|---|---|
| Not a relevant dealer, or said don't-call / hostile / not-interested | **Disqualified** |
| Agreed to a callback, **or** disclosed 3+ of the five info facts | **Qualified** |
| Disclosed at least 1 info fact | **Warm** |
| Heard the pitch, disclosed nothing | **Cold** |

This step is pure code. Given the same facts it always produces the same band,
and every band traces back to the facts behind it.

Why the split matters: a wrong band has only **two possible causes**, and each
has its own fix.

| What went wrong | Example | The fix |
|---|---|---|
| **The AI misread the call** | Marked "battery spec shared" when the dealer only named a brand | Teach it with an example (§5) |
| **The rule is off** | Read it right, but 3 facts shouldn't be enough to Qualify | Change the rule in `computeBand.ts` (a code change, on purpose) |

Almost every wrong band is the first kind.

---

## 3. What you do: correct it

You can review any AI call from **the lead's own detail screen** — the same
place you do everything else with that lead — or from the campaign transcript
drawer.

1. Open the lead. The **"What the AI learned"** panel shows the band, the
   yes/no fact checklist, and the evidence quote behind each fact.
2. Play the recording. Read the transcript.
3. If the band is wrong, click **Correct it**, pick the right one, and save.
4. Optionally add a note, or use **Refine signals (advanced)** to fix the
   individual facts the AI misread — that is the most useful kind of correction,
   because it says *why*.

**Your correction takes effect immediately.** The lead's band and score change
straight away and it re-routes through every queue, filter and dashboard
accordingly. The panel then shows "this lead is routing on a human correction".

> This is new. Until E-250 a correction was recorded but changed nothing — the
> lead kept routing on the AI's answer. If you corrected leads in the past and
> felt nothing happened, you were right.

**Who can do this:** admin, sales_head, sales_insight, ASM and inside sales.

### Instead of writing a long explanation, attach the recording

Under **Attached recordings** you can upload audio — for example a follow-up
call you made from your own phone. The system transcribes it and scores it
through the *same* engine that scores AI calls, so a human call gets read the
same way. Three uses:

- **Follow-up call** — transcribe and score it.
- **Evidence only** — store and play it, no transcription.
- **Re-read AI call** — when the provider's transcript came back garbled, this
  re-transcribes the AI's own audio and extracts the facts again, so you can see
  a second opinion next to the original.

Limits: mp3, m4a, wav, webm, ogg or flac, up to **25 MB** (about 50 minutes of
phone audio). That ceiling is the transcription service's, not ours.

Attaching audio does **not** move the lead by itself. It produces its own band;
you still decide by submitting a correction.

---

## 4. Aim for 20–30 corrections before reading anything into the numbers

With a handful, the report card is noise and any "learning" is learning from
accident. The console tells you when you are below that line.

---

## 5. Teaching the AI: **Admin → AI Intent Learning**

This is the part that used to require a developer. It no longer does.

Open **/admin/ai-intent** (admin, CEO, sales_head). Three panels:

**Report card.** How often reviewers agreed with the AI, and a breakdown of
where it goes wrong ("AI said Warm → really Cold ×7"). Read the caveat on the
page: this measures *agreement with reviewers*, not correctness.

**Calls the AI read wrong.** Every correction where a human overruled the AI,
with the transcript. Pick one and click **Teach the AI this**. You write one
sentence explaining what the model should learn — **the model reads that
sentence**, so write the rule, not the verdict:

> ✅ "A brand name alone is not a battery spec; mark battery_spec_shared no
> unless a voltage or Ah is stated."
> ❌ "This should have been cold."

**What the prompt currently teaches.** Everything promoted so far. Each can be
switched off with one click, which takes effect on the next call.

**No deploy is involved at any point.** Promote an example and the next call is
scored with it. Get it wrong and disable it. That reversibility is the reason
this lives in the database instead of in code.

A small set of built-in examples always applies underneath whatever you promote,
so the model can never be left with nothing to calibrate against.

---

## 6. The Google Sheet is retired

The `Campaign_Call_Review` tab had one column per reviewer, and **nothing ever
read it back** — feedback typed there reached no system, which is why the
learning loop stayed empty while people were genuinely reviewing every week.

The existing sheet feedback is imported once:

```bash
npm run intent:import-sheet                # dry run — shows what it would do
npm run intent:import-sheet -- --apply     # write it
npm run intent:import-sheet -- --db=prod   # against production
```

Cells that name a band become real corrections. Cells that are just prose are
kept as notes and deliberately **not** treated as verdicts — inventing a label
nobody wrote would poison the training set. Imported rows are never applied to
live leads; that history is months old.

After the import, sheet writing is off by default. Set
`CALL_REVIEW_SHEET_ENABLED=1` to keep mirroring to it during a transition.

---

## 7. The remaining terminal commands

| Command | Plain meaning |
|---|---|
| `npm run intent:export-golden` | Gather all corrections into one answer-key file. Reads sandbox **and** production and merges them (most recent correction wins). |
| `npm run eval:intent` | The offline report card, saved to `docs/ai intent/eval/report.html`. The in-app console shows the same thing live; this is for a deeper look. |
| `npm run intent:import-sheet` | The one-time Google Sheet import above. |

Reading production is **read-only** — these never write to it.

**One-time setup:** apply `drizzle/E-250_intent_review_loop.sql` (and, on an old
database, `E-159_intent_score_feedback.sql`) to **both** sandbox and production.
Re-running either file is a no-op.

---

## 8. One-paragraph summary

The AI reads each call into a yes/no fact checklist, and a fixed rule turns that
into a band. When the band is wrong you correct it from the lead screen — which
now actually moves the lead — and can attach a recording instead of writing an
explanation. Corrections collect in the database. An admin promotes the most
instructive ones on **AI Intent Learning**, and the scoring model reads them on
every call from that moment, with no deploy and a one-click undo. The loop
repeats, and the band gets more accurate — powered entirely by your corrections.
