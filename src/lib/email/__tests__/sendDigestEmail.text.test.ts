/**
 * The plain-text body keeps the headline and the "Right now" footer even when a
 * digest has no activity lines (Sales Daily is all tables) — tracker ID 9.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../mailer", () => ({ getMailer: () => ({}) }));
const { buildDigestEmail } = await import("../sendDigestEmail");

const kind = {
    id: "sales_daily",
    label: "Sales Daily",
    description: "",
    settingsKey: "sales_daily_digest",
    settingsHref: "/admin/settings/sales-daily",
    ctaHref: "/admin/reports/sales-dashboard",
    ctaLabel: "Open Sales Dashboard",
    sections: [],
    slots: ["morning"],
} as never;

const figures = {
    activity: [],
    backlog: [],
    headline: ["Yesterday: 2 dealers converted."],
    tables: [
        {
            key: "block_a",
            title: "A · Company",
            columns: ["Metric", "Yesterday"],
            rows: [["Leads in", "4"]],
            footer: {
                key: "right_now",
                label: "Right now · 09:00",
                items: [{ label: "Sales-ready, no owner", value: "3 leads", hint: "Oldest waiting 2 days" }],
            },
        },
    ],
};

describe("buildDigestEmail plain text", () => {
    it("keeps headline and footer with no activity lines", () => {
        const { text } = buildDigestEmail({ kind, to: ["x@y.z"], slot: "morning", istDay: "2026-09-30", figures });
        expect(text).toContain("Yesterday: 2 dealers converted.");
        expect(text).toContain("RIGHT NOW · 09:00");
        expect(text).toContain("Sales-ready, no owner: 3 leads (Oldest waiting 2 days)");
        expect(text).toContain("A · COMPANY");
    });

    it("drops them when their sections are switched off", () => {
        const { text } = buildDigestEmail({
            kind,
            to: ["x@y.z"],
            slot: "morning",
            istDay: "2026-09-30",
            figures,
            sections: { summary: false, right_now: false },
        });
        expect(text).not.toContain("Yesterday: 2 dealers converted.");
        expect(text).not.toContain("Sales-ready, no owner");
    });
});
