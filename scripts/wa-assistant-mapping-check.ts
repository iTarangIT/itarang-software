/**
 * Gate 6 — "disposition mapping checked against the CC sheet on 30 real call
 * notes" (BRD §9.3, §10 Day 6). READ-ONLY.
 *
 *   node --import tsx --env-file=.env.local scripts/wa-assistant-mapping-check.ts [--model]
 *
 * Real ground truth: NeoDove call touchpoints carry the rep's own note (the
 * quoted part of the remarks) AND the disposition the rep picked. So:
 *   1. Coverage — every recorded disposition, classified against the CC sheet
 *      and the frozen §9.3 map: in the map / in the sheet but outside the map
 *      (the Assistant would ASK) / not in the sheet at all.
 *   2. Aliases — 30 real notes (spread over dispositions): does any Hinglish
 *      alias fire, and does it agree with what the rep actually picked?
 *   3. --model — the real Gemini model maps each of the 30 notes to a
 *      log_call; its disposition is compared with the rep's. Needs quota.
 * The report quotes real dealer notes, so it goes to reports/ (gitignored),
 * never to the repo. Nothing is written to the database.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { SystemMessage, HumanMessage, type AIMessage } from "@langchain/core/messages";

import { db } from "../src/lib/db";
import { classifyDisposition } from "../src/lib/leads/dispositions";
import { callRowFor, HINGLISH_CALL_ALIASES } from "../src/lib/assistant/vocab";
import { toolsFor } from "../src/lib/assistant/registry";
import { buildSystemPrompt } from "../src/lib/assistant/prompt";
import { createToolCallingModel } from "../src/lib/assistant/agent";
import type { AssistantUser } from "../src/lib/assistant/types";

const SAMPLE = 30;

type Row = { disposition: string; remarks: string; created_at: string };

/** The rep's own words: the “quoted” tail NeoDove appends to its remarks. */
export function repNote(remarks: string): string | null {
    const m = /“([\s\S]*?)(?:”|$)/.exec(remarks);
    const note = m?.[1]?.replace(/\s+/g, " ").trim();
    return note && note.length >= 4 ? note : null;
}

/** Hinglish aliases found in a note (longest phrase first, no overlaps double-counted). */
export function aliasHits(note: string): string[] {
    const text = ` ${note.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
    return Object.entries(HINGLISH_CALL_ALIASES)
        .sort((a, b) => b[0].length - a[0].length)
        .filter(([phrase]) => text.includes(` ${phrase} `))
        .map(([, label]) => label);
}

type Coverage = "in_map" | "sheet_not_map" | "not_in_sheet";

function coverage(label: string): { cls: Coverage; canonical: string; connect: string | null; row: string | null } {
    const c = classifyDisposition(label);
    if (!c?.isKnown) return { cls: "not_in_sheet", canonical: label, connect: null, row: null };
    const row = callRowFor(c.label, c.connectStatus as "connected" | "not_connected");
    return { cls: row ? "in_map" : "sheet_not_map", canonical: c.label, connect: c.connectStatus, row: row?.id ?? null };
}

/** Spread the sample across dispositions: round-robin, newest first within each. */
function stratify(rows: (Row & { note: string })[], n: number) {
    const by = new Map<string, (Row & { note: string })[]>();
    for (const r of rows) by.set(r.disposition, [...(by.get(r.disposition) ?? []), r]);
    const queues = [...by.values()];
    const out: (Row & { note: string })[] = [];
    for (let i = 0; out.length < n && queues.some((q) => q.length > i); i++) {
        for (const q of queues) if (q[i] && out.length < n) out.push(q[i]);
    }
    return out;
}

async function modelDisposition(model: ReturnType<typeof createToolCallingModel>, system: string, note: string) {
    const ai = (await model.invoke([
        new SystemMessage(system),
        new HumanMessage(`Lead DL-MAPCHECK (already found, I own it). Just called them: ${note}`),
    ])) as AIMessage;
    const call = (ai.tool_calls ?? []).find((c) => c.name === "log_call");
    if (call) return { disposition: String(call.args.disposition ?? ""), asked: null as string | null };
    const text = typeof ai.content === "string"
        ? ai.content
        : ai.content.map((p) => (typeof p === "string" ? p : "text" in p && typeof p.text === "string" ? p.text : "")).join("");
    const other = (ai.tool_calls ?? []).map((c) => c.name).join(",");
    return { disposition: "", asked: (text.replace(/\s+/g, " ").trim() || `called ${other || "nothing"}`).slice(0, 120) };
}

async function main() {
    const useModel = process.argv.includes("--model");
    const rows = await db.execute<Row>(sql`
        SELECT disposition, remarks, created_at::text AS created_at
          FROM lead_touchpoints
         WHERE touchpoint_type = 'inside_sales_call' AND disposition IS NOT NULL
         ORDER BY created_at DESC`);

    // 1. Coverage over every recorded disposition.
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.disposition, (counts.get(r.disposition) ?? 0) + 1);
    const byClass: Record<Coverage, number> = { in_map: 0, sheet_not_map: 0, not_in_sheet: 0 };
    const table = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, n]) => {
            const c = coverage(label);
            byClass[c.cls] += n;
            return { label, n, ...c };
        });

    // 2. Thirty real notes, spread across dispositions.
    const withNotes = rows.flatMap((r) => {
        const note = repNote(r.remarks);
        return note ? [{ ...r, note }] : [];
    });
    const sample = stratify(withNotes, SAMPLE);
    const assessed = sample.map((r) => {
        const hits = aliasHits(r.note);
        const want = coverage(r.disposition).canonical;
        return { ...r, hits, aliasVerdict: hits.length === 0 ? "no alias" : hits.includes(want) ? "agrees" : "DISAGREES" };
    });

    // 3. Optional: the real model.
    let modelResults: { disposition: string; asked: string | null }[] | null = null;
    let modelError: string | null = null;
    if (useModel) {
        const key = process.env.WA_ASSIST_GEMINI_API_KEY;
        if (!key) modelError = "WA_ASSIST_GEMINI_API_KEY not set";
        else {
            const user: AssistantUser = { id: "mapcheck", name: "Mapping Check", role: "inside_sales_rep" };
            const tools = toolsFor(user.role, true);
            const model = createToolCallingModel({ model: process.env.ASSISTANT_MODEL || "gemini-3.6-flash", apiKey: key, tools });
            const system = buildSystemPrompt({ user, now: new Date(), tools: tools.map((t) => t.name), writesEnabled: true });
            modelResults = [];
            for (const r of assessed) {
                try {
                    modelResults.push(await modelDisposition(model, system, r.note));
                } catch (e) {
                    modelError = e instanceof Error ? e.message.slice(0, 300) : String(e);
                    break;
                }
                await new Promise((res) => setTimeout(res, 3500)); // free tier: 20 req/min
            }
        }
    }

    // Report.
    const pct = (n: number) => `${((100 * n) / rows.length).toFixed(1)}%`;
    const md: string[] = [
        `# WA Assistant — disposition mapping check (${new Date().toISOString().slice(0, 10)})`,
        "",
        `Source: ${rows.length} inside_sales_call touchpoints with a recorded disposition (DB host ${new URL(process.env.DATABASE_URL!).hostname}).`,
        "",
        "## 1. Coverage of the frozen §9.3 map",
        "",
        `- In the map: **${byClass.in_map}** (${pct(byClass.in_map)})`,
        `- In the CC sheet, outside the map — the Assistant would ask a question: **${byClass.sheet_not_map}** (${pct(byClass.sheet_not_map)})`,
        `- Not in the CC sheet at all: **${byClass.not_in_sheet}** (${pct(byClass.not_in_sheet)})`,
        "",
        "| Recorded disposition | Calls | Sheet label | Connect | §9.3 row |",
        "|---|---:|---|---|---|",
        ...table.map((t) => `| ${t.label} | ${t.n} | ${t.cls === "not_in_sheet" ? "—" : t.canonical} | ${t.connect ?? "—"} | ${t.row ?? (t.cls === "sheet_not_map" ? "**none → asks**" : "—")} |`),
        "",
        `## 2. ${assessed.length} real notes (spread over ${new Set(assessed.map((a) => a.disposition)).size} dispositions)`,
        "",
        `Notes with a rep-written part: ${withNotes.length}. Alias hits: ${assessed.filter((a) => a.hits.length).length}; agree ${assessed.filter((a) => a.aliasVerdict === "agrees").length}, disagree ${assessed.filter((a) => a.aliasVerdict === "DISAGREES").length}.`,
        "",
        `| # | Rep picked | Note | Alias hit | Verdict${modelResults ? " | Model | Model verdict" : ""} |`,
        `|---|---|---|---|---${modelResults ? "|---|---" : ""}|`,
        ...assessed.map((a, i) => {
            const m = modelResults?.[i];
            const want = coverage(a.disposition).canonical;
            const mv = !m ? "" : m.disposition ? (m.disposition === want ? "agrees" : "DISAGREES") : `asked: ${m.asked}`;
            return `| ${i + 1} | ${a.disposition} | ${a.note.replace(/\|/g, "/").slice(0, 110)} | ${a.hits.join(", ") || "—"} | ${a.aliasVerdict}${modelResults ? ` | ${m?.disposition || "—"} | ${mv}` : ""} |`;
        }),
        "",
        useModel ? `Model run: ${modelResults?.length ?? 0}/${assessed.length} notes${modelError ? ` — stopped: ${modelError}` : ""}.` : "Model run: not requested (pass --model).",
    ];
    mkdirSync("reports", { recursive: true });
    const out = `reports/wa-assistant-mapping-check-${new Date().toISOString().slice(0, 10)}.md`;
    writeFileSync(out, md.join("\n"));

    console.log(`calls with a disposition: ${rows.length}`);
    console.log(`coverage: in map ${byClass.in_map} (${pct(byClass.in_map)}), sheet-not-map ${byClass.sheet_not_map} (${pct(byClass.sheet_not_map)}), not in sheet ${byClass.not_in_sheet} (${pct(byClass.not_in_sheet)})`);
    for (const t of table.filter((x) => x.cls !== "in_map")) console.log(`  outside the map: ${t.label} ×${t.n} (${t.cls})`);
    console.log(`sample: ${assessed.length} notes; alias hits ${assessed.filter((a) => a.hits.length).length}, agree ${assessed.filter((a) => a.aliasVerdict === "agrees").length}, disagree ${assessed.filter((a) => a.aliasVerdict === "DISAGREES").length}`);
    for (const a of assessed.filter((x) => x.aliasVerdict === "DISAGREES")) console.log(`  DISAGREES: picked "${a.disposition}", alias → ${a.hits.join(", ")}`);
    if (useModel) {
        const agree = modelResults?.filter((m, i) => m.disposition === coverage(assessed[i]!.disposition).canonical).length ?? 0;
        console.log(`model: ${modelResults?.length ?? 0}/${assessed.length} run, ${agree} agree${modelError ? ` — stopped: ${modelError}` : ""}`);
    }
    console.log(`report: ${out}`);
    process.exit(0);
}

void main();
