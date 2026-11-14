// AI Analyst golden suite — the pure check (item 2). Client-safe, no imports.
//
// Each golden question has reference SQL that the CRM's own definitions agree on. The suite
// asks the agent the question, runs the reference on the same read-only login, and passes
// when every reference figure is in the agent's answer: a result cell or a number written in
// the answer text. "Where" the figure sits is left to the agent — the CEO reads both.

/** Every number in a result table or an answer: "₹1,23,456.50" → 123456.5, "12%" → 12. */
export function numbersIn(rows: unknown[][], answer: string): number[] {
    const out: number[] = [];
    const visit = (cell: unknown) => {
        if (typeof cell === "number" && Number.isFinite(cell)) out.push(cell);
        else if (typeof cell === "string") out.push(...numbersInText(cell));
        else if (Array.isArray(cell)) cell.forEach(visit);
    };
    rows.forEach((row) => row.forEach(visit));
    out.push(...numbersInText(answer));
    return out;
}

export function numbersInText(text: string): number[] {
    const out: number[] = [];
    // Indian grouping (1,23,456) and western (123,456) both; an optional decimal part.
    for (const m of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
        const n = Number(m[0].replace(/,/g, ""));
        if (Number.isFinite(n)) out.push(n);
    }
    // "1.2 lakh", "3.4 crore"
    for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(lakh|lac|crore|cr)\b/gi)) {
        const scale = /^l/i.test(m[2]) ? 1e5 : 1e7;
        out.push(Number(m[1]) * scale);
    }
    return out;
}

/** Equal within `tolerance` (a fraction of the expected value; 0 = exact after rounding to 2 dp). */
export function near(expected: number, got: number, tolerance = 0): boolean {
    if (Math.round(expected * 100) === Math.round(got * 100)) return true;
    if (tolerance <= 0) return false;
    return Math.abs(expected - got) <= Math.abs(expected) * tolerance;
}

export type GoldenVerdict = {
    pass: boolean;
    missing: number[];
    /** The reference was empty or all zero: a pass proves little. */
    weak: boolean;
};

export function checkGolden(expected: number[], rows: unknown[][], answer: string, tolerance = 0): GoldenVerdict {
    const found = numbersIn(rows, answer);
    // An expected 0 also passes when the agent returned no rows ("no visits"), which is how a
    // zero usually comes back.
    const missing = expected.filter(
        (e) => !found.some((g) => near(e, g, tolerance)) && !(e === 0 && rows.length === 0),
    );
    const weak = expected.length === 0 || expected.every((e) => e === 0);
    // No reference rows (nothing in the period): right when the agent found nothing either.
    if (expected.length === 0) return { pass: rows.length === 0, missing: [], weak };
    return { pass: missing.length === 0, missing, weak };
}
