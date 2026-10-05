import { afterEach, describe, expect, it } from "vitest";
import { fromVercelCron } from "../cronAuth";

const req = (headers: Record<string, string>) => ({
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
});

describe("fromVercelCron (ID 118)", () => {
    const before = process.env.VERCEL;
    afterEach(() => {
        if (before === undefined) delete process.env.VERCEL;
        else process.env.VERCEL = before;
    });

    it("off Vercel the header proves nothing — the VPS does not strip it", () => {
        delete process.env.VERCEL;
        expect(fromVercelCron(req({ "x-vercel-cron": "1" }))).toBe(false);
    });

    it("on Vercel the scheduler's header is trusted; a request without it is not", () => {
        process.env.VERCEL = "1";
        expect(fromVercelCron(req({ "x-vercel-cron": "1" }))).toBe(true);
        expect(fromVercelCron(req({}))).toBe(false);
    });
});
