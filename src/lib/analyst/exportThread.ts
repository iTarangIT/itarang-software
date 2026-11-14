// AI Analyst — a conversation as a Markdown document, for "Download". Pure.

import { formatWhen } from "./when";

export type ExportRun = {
    question: string;
    answer: string | null;
    error: string | null;
    sql: string | null;
    created_at: string;
    verified?: boolean;
};

export function threadToMarkdown(input: {
    title: string;
    owner?: string | null;
    exportedAt?: Date;
    runs: ExportRun[];
}): string {
    const lines: string[] = [`# ${input.title.replace(/\s+/g, " ").trim() || "AI Analyst conversation"}`, ""];
    const meta = [
        input.owner ? `Asked by ${input.owner}` : null,
        `Exported ${formatWhen(input.exportedAt ?? new Date())} (IST)`,
        `${input.runs.length} question${input.runs.length === 1 ? "" : "s"}`,
    ].filter(Boolean);
    lines.push(`_${meta.join(" · ")}_`, "");

    input.runs.forEach((run, i) => {
        lines.push("---", "", `## ${i + 1}. ${run.question.trim()}`, "");
        const when = formatWhen(run.created_at);
        if (when) lines.push(`_Asked ${when}${run.verified ? " · ✔ Verified query" : ""}_`, "");
        if (run.answer) lines.push(run.answer.trim(), "");
        else if (run.error) lines.push(`> The analyst could not answer: ${run.error.trim()}`, "");
        else lines.push("_No answer was recorded._", "");
        if (run.sql) lines.push("<details><summary>Query</summary>", "", "```sql", run.sql.trim(), "```", "", "</details>", "");
    });

    lines.push("---", "", "_Results are not stored with the conversation — ask again in the AI Analyst for fresh numbers._", "");
    return lines.join("\n");
}

/** A file name from a title: "Revenue this month vs last" → "revenue-this-month-vs-last.md". */
export function exportFileName(title: string): string {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
        .replace(/-+$/, "");
    return `${slug || "analyst-conversation"}.md`;
}
