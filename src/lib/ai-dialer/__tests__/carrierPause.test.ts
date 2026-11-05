import { describe, expect, it } from "vitest";
import {
    afterProbe,
    CARRIER_PAUSE_REASON,
    CARRIER_PAUSE_THRESHOLD,
    clampToProbeHours,
    decidePause,
    istDay,
    lineBlockKind,
    MAX_PROBES,
    pauseThreshold,
    probeDue,
    SETUP_PAUSE_REASON,
    SETUP_PAUSE_THRESHOLD,
    withinProbeHours,
} from "../carrierPause";
import { isLineBlockedFailure } from "../retryPolicy";
import { normaliseProbeNumber, parseDialerAlertSettings } from "../dialerAlertSettings";

const ist = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 10, day, hh, mm) - 330 * 60_000);
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("lineBlockKind — which failures pause a campaign", () => {
    it.each([401, 403, 407, 429, 503])("SIP %d is a carrier refusal", (code) => {
        expect(lineBlockKind(`trigger_failed: INVITE failed: sip status: ${code}: X`)).toBe("carrier");
    });

    it.each([486, 480, 487, 404, 410, 603, 500, 502])("SIP %d is the dealer's line or a one-off, never a pause", (code) => {
        expect(lineBlockKind(`trigger_failed: sip status: ${code}`)).toBeNull();
    });

    it("an asynchronous initiation failure carrying the code counts too", () => {
        expect(lineBlockKind("unknown (sip status: 503)")).toBe("carrier");
        expect(lineBlockKind("busy (sip status: 486)")).toBeNull();
    });

    it("rate-limit text without a code is the carrier", () => {
        expect(lineBlockKind("trigger_failed: Too Many Requests")).toBe("carrier");
    });

    it("a config error on a trigger is a setup error; the same words elsewhere are not", () => {
        expect(lineBlockKind("trigger_failed: Missing ELEVENLABS_AGENT_ID / api key")).toBe("setup");
        expect(lineBlockKind("no_webhook")).toBeNull();
        expect(lineBlockKind(null)).toBeNull();
        expect(lineBlockKind("")).toBeNull();
    });

    it("isLineBlockedFailure (the refund) agrees: 503 is refunded, 486 is not", () => {
        expect(isLineBlockedFailure("trigger_failed: sip status: 503")).toBe(true);
        expect(isLineBlockedFailure("trigger_failed: sip status: 486")).toBe(false);
        expect(isLineBlockedFailure("unknown (sip status: 403)")).toBe(true);
    });

    it("thresholds: 10 carrier refusals, 3 setup errors", () => {
        expect(pauseThreshold("carrier")).toBe(CARRIER_PAUSE_THRESHOLD);
        expect(CARRIER_PAUSE_THRESHOLD).toBe(10);
        expect(pauseThreshold("setup")).toBe(SETUP_PAUSE_THRESHOLD);
    });
});

describe("probe hours (10:00–19:00 IST)", () => {
    it("inside / outside", () => {
        expect(withinProbeHours(ist(5, 10, 0))).toBe(true);
        expect(withinProbeHours(ist(5, 18, 59))).toBe(true);
        expect(withinProbeHours(ist(5, 19, 0))).toBe(false);
        expect(withinProbeHours(ist(5, 9, 59))).toBe(false);
    });

    it("clamps before opening to 10:00 today, after closing to 10:00 tomorrow", () => {
        expect(iso(clampToProbeHours(ist(5, 7)))).toBe(iso(ist(5, 10)));
        expect(iso(clampToProbeHours(ist(5, 19, 10)))).toBe(iso(ist(6, 10)));
        expect(iso(clampToProbeHours(ist(5, 23, 50)))).toBe(iso(ist(6, 10)));
        expect(iso(clampToProbeHours(ist(5, 12)))).toBe(iso(ist(5, 12)));
    });

    it("istDay rolls over at IST midnight, not UTC midnight", () => {
        expect(istDay(ist(5, 23, 59))).toBe("2026-11-05");
        expect(istDay(ist(6, 0, 1))).toBe("2026-11-06");
    });
});

describe("decidePause", () => {
    it("first carrier pause of the day: probe in 30 minutes, no person needed", () => {
        const d = decidePause({ kind: "carrier", now: ist(5, 13), previous: { pauseDay: null, pausesToday: null } });
        expect(d).toMatchObject({ reason: CARRIER_PAUSE_REASON, pausesToday: 1, needsManualResume: false });
        expect(iso(d.nextProbeAt)).toBe(iso(ist(5, 13, 30)));
    });

    it("a pause at 18:45 books its probe for 10:00 next morning", () => {
        const d = decidePause({ kind: "carrier", now: ist(5, 18, 45), previous: { pauseDay: null, pausesToday: 0 } });
        expect(iso(d.nextProbeAt)).toBe(iso(ist(6, 10)));
    });

    it("the second pause the same IST day waits for a person, with no probe booked", () => {
        const d = decidePause({ kind: "carrier", now: ist(5, 16), previous: { pauseDay: "2026-11-05", pausesToday: 1 } });
        expect(d).toMatchObject({ pausesToday: 2, needsManualResume: true, nextProbeAt: null });
    });

    it("yesterday's pause does not count: a new day starts at 1", () => {
        const d = decidePause({ kind: "carrier", now: ist(6, 11), previous: { pauseDay: "2026-11-05", pausesToday: 3 } });
        expect(d).toMatchObject({ pausesToday: 1, needsManualResume: false });
    });

    it("a setup error is never probed and always waits for a person", () => {
        const d = decidePause({ kind: "setup", now: ist(5, 11), previous: { pauseDay: null, pausesToday: null } });
        expect(d).toMatchObject({ reason: SETUP_PAUSE_REASON, needsManualResume: true, nextProbeAt: null });
    });
});

describe("afterProbe / probeDue", () => {
    it("a placed probe resumes", () => {
        expect(afterProbe({ placed: true, probesUsed: 3, now: ist(5, 12) })).toEqual({ kind: "resume" });
    });

    it("a refused probe books the next one 30 minutes on", () => {
        const r = afterProbe({ placed: false, probesUsed: 1, now: ist(5, 12) });
        expect(r.kind).toBe("again");
        if (r.kind === "again") expect(iso(r.nextProbeAt)).toBe(iso(ist(5, 12, 30)));
    });

    it("the 6th refused probe stops the automatic probing", () => {
        expect(afterProbe({ placed: false, probesUsed: MAX_PROBES, now: ist(5, 12) })).toEqual({ kind: "exhausted" });
        expect(afterProbe({ placed: false, probesUsed: MAX_PROBES - 1, now: ist(5, 12) }).kind).toBe("again");
    });

    it("a refused probe at 18:40 books the next for 10:00 tomorrow", () => {
        const r = afterProbe({ placed: false, probesUsed: 2, now: ist(5, 18, 40) });
        if (r.kind !== "again") throw new Error("expected again");
        expect(iso(r.nextProbeAt)).toBe(iso(ist(6, 10)));
    });

    const base = {
        reason: CARRIER_PAUSE_REASON,
        needsManualResume: false,
        nextProbeAt: ist(5, 12),
        probesUsed: 0,
        now: ist(5, 12, 1),
    };
    it("due only for a carrier pause, not manual, at or after its time, under the cap, inside hours", () => {
        expect(probeDue(base)).toBe(true);
        expect(probeDue({ ...base, reason: SETUP_PAUSE_REASON })).toBe(false);
        expect(probeDue({ ...base, needsManualResume: true })).toBe(false);
        expect(probeDue({ ...base, now: ist(5, 11, 59) })).toBe(false);
        expect(probeDue({ ...base, probesUsed: MAX_PROBES })).toBe(false);
        expect(probeDue({ ...base, nextProbeAt: null })).toBe(false);
        expect(probeDue({ ...base, nextProbeAt: ist(5, 18), now: ist(5, 19, 5) })).toBe(false);
    });
});

describe("Settings › Dialer alerts", () => {
    it("defaults: it@itarang.com, the tracker's probe number, nobody picked", () => {
        expect(parseDialerAlertSettings(null)).toMatchObject({
            userIds: [],
            emails: ["it@itarang.com"],
            probeNumber: "9971027907",
        });
    });

    it("drops invalid emails and duplicate users; a bad probe number falls back", () => {
        const s = parseDialerAlertSettings({
            user_ids: ["u1", "u1", "u2"],
            emails: ["IT@itarang.com", "not-an-email", "it@itarang.com"],
            probe_number: "12345",
        });
        expect(s.userIds).toEqual(["u1", "u2"]);
        expect(s.emails).toEqual(["it@itarang.com"]);
        expect(s.probeNumber).toBe("9971027907");
    });

    it("an empty email list stays empty (someone removed it on purpose)", () => {
        expect(parseDialerAlertSettings({ emails: [] }).emails).toEqual([]);
    });

    it.each([
        ["9971027907", "9971027907"],
        ["+91 99710 27907", "9971027907"],
        ["09971027907", "9971027907"],
        ["5971027907", null],
        ["997102790", null],
        ["", null],
    ])("probe number %s → %s", (raw, want) => {
        expect(normaliseProbeNumber(raw)).toBe(want);
    });
});
