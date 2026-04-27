---
name: db-schema
description: Generate and inspect the iTarang database catalog and multi-source schema drift report. Use when the user asks "/db-schema", or asks to catalog/document tables, find which UI/API/service files use a table, regenerate the per-table reference, check schema drift, compare branch vs main vs sandbox vs production schemas, or audit what's queued to ship vs what's already in production. Always invoke when the user types `/db-schema`, `/db-schema catalog`, `/db-schema drift`, or `/db-schema all`.
---

# `/db-schema` — DB catalog + multi-source drift report

This skill generates two artifacts in `docs/db/`:

1. **Catalog** — committed per-table markdown reference (purpose: "what is this table for, and which files touch it?") plus a combined `catalog.docx`. Source of truth: `src/lib/db/schema.ts`. Output: `docs/db/catalog/`.

2. **Drift report** — timestamped `.docx` answering "how do branch / main / sandbox / production schemas differ right now?" Output: `docs/db/drift/<YYYY-MM-DD-HHMM>/drift-report.docx` plus `summary.json` sidecar.

The two artifacts have different cadences and are deliberately kept in separate sub-commands.

## Sub-commands

| Invocation | Action |
| --- | --- |
| `/db-schema catalog` | Run `npm run db:catalog`. Regenerates `docs/db/catalog/`. |
| `/db-schema drift` | Run `npm run db:drift`. Writes a new timestamped folder under `docs/db/drift/`. |
| `/db-schema all` | Run `db:catalog`, then `db:drift`. |
| `/db-schema` (no arg) | Ask the user which one. Default suggestion: `drift` (more frequent need). |

## How to run

When the user invokes the skill:

1. Determine the sub-command from the user's argument. If absent, ask once which one (offer `catalog`, `drift`, `all`).
2. Execute the corresponding npm script with `Bash`. Both scripts auto-load `.env.local`. The drift script also reads `DATABASE_URL` from `.env.production` for the production introspection (read-only queries against `information_schema` and `pg_constraint`).
3. Wait for the script to finish. Both scripts exit non-zero on hard failure; partial failures (e.g., prod creds missing) are reported in `summary.json` and logged to stderr — that is fine and should be surfaced, not retried.
4. Summarize the result in chat (see "How to summarize" below).

## How to summarize

### After `db:catalog`

Read `docs/db/catalog/README.md` (the index) and report:

- The number of tables documented.
- The 3–5 highest-traffic tables by code references (you can `wc -l` the per-table `.md` files or grep "API routes (" counts).
- Any table whose per-table `.md` ends with the "No code references found" warning — these are unused-or-suspicious candidates and worth flagging.

Link to `docs/db/catalog/README.md` and `docs/db/catalog/catalog.docx`.

### After `db:drift`

Read the freshly-written `docs/db/drift/<ts>/summary.json`. Report:

- The four diff summary lines from `summary.diff1`–`summary.diff4`.
- For any non-empty diff, list the **table names** involved (already pre-computed in `summary.diff1.tablesAdded` / `tablesRemoved` / `tablesChanged`). For diffs 2/3/4, you may need to read the `.docx` summary section or re-run with parsing — but for the first pass, the high-level summary line is enough.
- If a diff was skipped (e.g., `prodError`), state plainly that prod creds were not available — do not pretend the diff was clean.

Link to `docs/db/drift/<ts>/drift-report.docx` and `summary.json`.

## Failure modes to expect

- **`DATABASE_URL` not set** — sandbox introspection (Diff 2, Diff 3) and the catalog row-count step will skip. Tell the user to ensure `.env.local` exists. Do not invent values.
- **`.env.production` missing or no `DATABASE_URL` in it** — Diff 3 and Diff 4 will skip. Report this explicitly.
- **`git show main:src/lib/db/schema.ts` fails** — the script falls back to a raw `git diff` for Diff 1. Mention the fallback in the chat summary.
- **`rg` (ripgrep) not installed** — the catalog script will fail. ripgrep is standard on macOS via Homebrew (`brew install ripgrep`); fall back is not currently implemented.

## Notes for the implementer / future maintainer

- The catalog `.docx` is a binary blob — regenerating produces noisy git diffs. If that becomes painful, gitignore `docs/db/catalog/catalog.docx` and have CI generate it on demand. Markdown stays committed regardless.
- Drift folders are timestamped, so `git add docs/db/drift/<ts>/` is always safe (no overwrites of prior runs).
- Live-DB queries are strictly read-only (`information_schema`, `pg_indexes`, `pg_constraint`). Never run anything mutating from this skill.
- Do not commit any DB password; the scripts only read URLs from `.env.local` / `.env.production` and never echo them.
