import path from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { IotSql } from "@/lib/telemetry/charging-sql";
import {
    CYCLE_KM_FACTOR_MAX,
    CYCLE_KM_FACTOR_MIN,
    calibrateCycleKm,
    windowsCTE,
} from "@/lib/telemetry/cycle-distance";

// Same render harness as charging-sql.test.ts: reach postgres.js's internal stringifier
// so composed SQL renders without a connection. See that file for why the import is by
// absolute path.
const { stringify } = (await import(
    pathToFileURL(
        path.join(process.cwd(), "node_modules/postgres/src/types.js"),
    ).href
)) as {
    stringify: (
        q: unknown,
        string: string,
        value: unknown,
        parameters: unknown[],
        types: unknown[],
        options: unknown,
    ) => string;
};

const sql = postgres("postgres://u:p@127.0.0.1:1/db", { prepare: false }) as IotSql;
const sqlOptions = (sql as unknown as { options: unknown }).options;

function render(query: unknown): { text: string; params: unknown[] } {
    const q = query as { strings: TemplateStringsArray; args: unknown[] };
    const params: unknown[] = [];
    const text = stringify(q, q.strings[0], q.args[0], params, [], sqlOptions);
    return { text, params };
}

function flat(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

// ─── calibrateCycleKm ────────────────────────────────────────────────────────
//
// GPS chord distance is a known lower bound (~27% short on the reference battery), so a
// cycle's raw GPS km is scaled by that day's rollup/GPS ratio. Days without a usable
// ratio use the period-global one; no ratio anywhere leaves the raw chord flagged 'gps'.

const day = (d: string, km: number): [string, number] => [d, km];

describe("calibrateCycleKm", () => {
    it("scales a single-day cycle by that day's rollup/GPS factor", () => {
        const out = calibrateCycleKm(
            [{ id: 1, day: "2026-06-01", gpsKm: 8 }],
            new Map([day("2026-06-01", 10)]),
            new Map([day("2026-06-01", 12)]),
        );
        expect(out.get(1)).toEqual({ km: 9.6, source: "calibrated" });
    });

    it("applies each day's own factor to a cycle spanning midnight", () => {
        const out = calibrateCycleKm(
            [
                { id: 1, day: "2026-06-01", gpsKm: 5 },
                { id: 1, day: "2026-06-02", gpsKm: 4 },
            ],
            new Map([day("2026-06-01", 10), day("2026-06-02", 8)]),
            new Map([day("2026-06-01", 12), day("2026-06-02", 8)]),
        );
        // 5 × 1.2 + 4 × 1.0
        expect(out.get(1)).toEqual({ km: 10, source: "calibrated" });
    });

    it("falls back to the period-global factor on a day with no rollup row", () => {
        const out = calibrateCycleKm(
            [
                { id: 1, day: "2026-06-01", gpsKm: 5 },
                { id: 1, day: "2026-06-03", gpsKm: 2 },
            ],
            new Map([day("2026-06-01", 10), day("2026-06-03", 2)]),
            new Map([day("2026-06-01", 12)]), // no rollup on 06-03
        );
        // Global factor = 12/10 over the one trusted day; 5×1.2 + 2×1.2 = 8.4
        expect(out.get(1)).toEqual({ km: 8.4, source: "calibrated" });
    });

    it("treats a wildly disagreeing day as untrusted and keeps it out of the global factor", () => {
        // 06-02's ratio is 50/2 = 25 — a partial-day tracker outage must not mint km.
        const out = calibrateCycleKm(
            [{ id: 1, day: "2026-06-02", gpsKm: 2 }],
            new Map([day("2026-06-01", 10), day("2026-06-02", 2)]),
            new Map([day("2026-06-01", 12), day("2026-06-02", 50)]),
        );
        // Falls back to the global factor built ONLY from trusted days: 12/10.
        expect(out.get(1)).toEqual({ km: 2.4, source: "calibrated" });
    });

    it("returns the raw GPS chord flagged 'gps' when no factor is computable anywhere", () => {
        const out = calibrateCycleKm(
            [{ id: 7, day: "2026-06-01", gpsKm: 3.25 }],
            new Map([day("2026-06-01", 3.25)]),
            new Map(), // rollup absent for the whole window
        );
        expect(out.get(7)).toEqual({ km: 3.3, source: "gps" });
    });

    it("returns an empty map for no input rows", () => {
        expect(calibrateCycleKm([], new Map(), new Map()).size).toBe(0);
    });

    it("exposes a sane clamp band", () => {
        expect(CYCLE_KM_FACTOR_MIN).toBeLessThan(1);
        expect(CYCLE_KM_FACTOR_MAX).toBeGreaterThan(1);
    });
});

// ─── windowsCTE ──────────────────────────────────────────────────────────────

describe("windowsCTE", () => {
    it("binds ids, starts and ends as three parallel arrays", () => {
        const w1 = {
            id: 1,
            start: new Date("2026-06-01T08:00:00Z"),
            end: new Date("2026-06-01T12:00:00Z"),
        };
        const w2 = {
            id: 2,
            start: new Date("2026-06-02T09:00:00Z"),
            end: new Date("2026-06-02T10:30:00Z"),
        };
        const { text, params } = render(windowsCTE(sql, [w1, w2]));
        expect(flat(text)).toBe(
            "windows AS ( SELECT * FROM unnest( $1::int[], $2::timestamptz[], $3::timestamptz[] ) AS w(win_id, start_time, end_time) )",
        );
        expect(params).toEqual([
            [1, 2],
            [w1.start, w2.start],
            [w1.end, w2.end],
        ]);
    });
});
