# AI Analyst — 14 Nov changes

All CRM-side; no agent deploy. Two new tables, both behind `to_regclass` (the page works
without them, the new controls just hide): **E-381** `analyst_threads`, **E-382**
`analyst_verified_queries`. Apply with `node scripts/_apply-e381-e382.mjs database-1|database-2`.

| # | Change | Where |
|---|--------|-------|
| 1 | **Verified queries.** Shield button under an answer (CEO / Sales Head / admin) marks its SQL verified. A new question close to a verified one (token overlap ≥ 0.6) is sent with that SQL in the agent's `instructions`, after the metric rules. An answer whose SQL is a verified one shows a green **Verified** badge. List + Unverify at `/ceo/analyst/verified`. | `lib/analyst/verified.ts`, `verifiedStore.ts`, `api/analyst/verified`, `components/analyst/verified.tsx` |
| 2 | **Golden suite** — 20 real CEO / Sales Head questions with reference SQL. **Run before every release:** `npm run analyst:golden` (`--reference-only` checks the SQL without spending agent budget; `--only G01,G15` runs some). Exit 1 on any failure; report in `reports/analyst-golden-<date>.json`. | `lib/analyst/goldenQuestions.ts`, `golden.ts`, `scripts/verify-analyst-golden.ts` |
| 3 | Each user sees only their own conversations — the agent's list cut to their thread prefix, plus the CRM's own rows, so older conversations no longer drop off the tenant-wide top 200. | `threadStore.ts` `ownThreadList` |
| 4 | Titles wrap to two lines; the full title shows on hover. | `ThreadColumn.tsx` |
| 5 | The open conversation's title is in the header, with a pencil to rename it. | `conversation.tsx` |
| 6 | Follow-up chips under every answer ("Same for yesterday", "Split by salesperson", "Show the leads", …), rule-based, no extra model call. | `lib/analyst/followUps.ts` |
| 7 | Pencil on a question: edit it and "Save & ask" — asked as a new turn in the same conversation (the agent keeps every run, so the original stays). | `parts.tsx` `UserMessage` |
| 8 | Delete from the row menu (with a confirm). Soft: the row is marked, nothing is removed. | `api/analyst/threads/[threadId]` DELETE |
| 9 | Search box over titles and every question asked. | `threadList.ts` `viewThreads` |
| 10 | Pin to top. | row menu |
| 11 | Archive / Unarchive; an "Archived (n)" view. Asking in an archived conversation brings it back. | row menu |
| 12 | Starter questions: the user's own most-asked first ("You often ask"), then the defaults. | `lib/analyst/starters.ts` |
| 13 | **Share**: a read-only link (`/analyst/shared/<token>`) any CEO / Sales Head / admin can open; Stop sharing kills it. **Export**: Download (Markdown, with each query) and Print / Save as PDF (`/analyst/print?thread=…`). | `conversation.tsx` `ShareMenu`, `AnalystTranscript.tsx` |
