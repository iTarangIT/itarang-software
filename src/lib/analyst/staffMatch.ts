// AI Analyst (13 Nov) — how a staff name in a question is matched, written the way the
// analyst's staff rule (metricDefinitions.ts ANALYST_RULES) asks the agent to do it, so a
// check script can match names exactly the same way. Pure; no imports.

/** The ILIKE patterns a name must ALL match: one per word, each a partial match. */
export function staffNamePatterns(name: string): string[] {
    return name
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/[%_\\]/g, "").trim())
        .filter((w) => w.length >= 2)
        .map((w) => `%${w}%`);
}

/** Does a stored full name match the asked name (every word, case-insensitive, partial)? */
export function staffNameMatches(stored: string, asked: string): boolean {
    const hay = stored.toLowerCase();
    const words = staffNamePatterns(asked).map((p) => p.slice(1, -1).toLowerCase());
    return words.length > 0 && words.every((w) => hay.includes(w));
}
