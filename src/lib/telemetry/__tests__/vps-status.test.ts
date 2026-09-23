import { describe, expect, it } from "vitest";

import { isVpsUnreachable, vpsDegradedReason } from "@/lib/telemetry/vps-status";

/** A postgres.js/libpq-style connection failure: message plus a `code`. */
function connError(code: string, message = code): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

describe("isVpsUnreachable", () => {
    it("recognises the connection failures by code", () => {
        for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"]) {
            expect(isVpsUnreachable(connError(code))).toBe(true);
        }
    });

    it("recognises a dropped tunnel from the message alone", () => {
        // postgres.js does not always attach `code` — when the socket dies
        // mid-handshake the failure arrives as bare text.
        expect(isVpsUnreachable(new Error("read ECONNRESET"))).toBe(true);
        expect(isVpsUnreachable(new Error("Connection terminated unexpectedly"))).toBe(true);
        expect(isVpsUnreachable(new Error("IOT_DATABASE_URL is not set"))).toBe(true);
    });

    it("does NOT swallow a real query bug", () => {
        // A 42703 "column does not exist" must keep its 500 and reach the logs.
        // Classifying it as "VPS unreachable" would render an amber "check the
        // tunnel" banner over a broken migration and send everyone hunting the
        // network for a bug that is in the SQL.
        expect(isVpsUnreachable(connError("42703", 'column "soc" does not exist'))).toBe(false);
        expect(isVpsUnreachable(connError("42P01", 'relation "trips" does not exist'))).toBe(false);
        expect(isVpsUnreachable(new Error("syntax error at or near GROUP"))).toBe(false);
    });
});

describe("vpsDegradedReason", () => {
    it("names the specific cause rather than always blaming the tunnel", () => {
        expect(vpsDegradedReason(new Error("IOT_DATABASE_URL is not set"))).toMatch(
            /not configured/i,
        );
        expect(vpsDegradedReason(connError("ENOTFOUND"))).toMatch(/host not found/i);
        expect(vpsDegradedReason(connError("ETIMEDOUT"))).toMatch(/timed out/i);
    });

    it("tells the reader a reset connection is a dead tunnel, not a dead database", () => {
        const reason = vpsDegradedReason(connError("ECONNRESET", "read ECONNRESET"));
        expect(reason).toMatch(/connection (was )?reset|tunnel/i);
    });
});
