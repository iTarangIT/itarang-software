import { describe, expect, it } from "vitest";
import {
    cleanDays,
    defaultSmsPlan,
    normaliseSmsPlan,
    overdueSendDays,
    smsStepFor,
    smsTemplateFor,
    smsWindow,
    toDltText,
} from "@/lib/emi-messages/sms-plan";
import { fillText, lendersOn, smsValues } from "@/lib/emi-messages/rules";

describe("SMS plan defaults (4 Nov)", () => {
    it("7, 5, 1 days before, आज on the day, daily overdue for 30 days, no DLT ids", () => {
        const p = defaultSmsPlan();
        expect(p.beforeDays).toEqual([7, 5, 1]);
        expect(p.dueToday).toBe(true);
        expect(p.overdue).toMatchObject({ on: true, mode: "daily", stopAfter: 30 });
        expect(p.reminders).toHaveLength(31);
        expect([...p.reminders, p.dueTodayTpl, p.overdueTpl, p.receivedTpl].every((t) => t.dltTemplateId === "")).toBe(true);
    });

    it("each reminder carries its own day, the support line and the ignore line", () => {
        const p = defaultSmsPlan();
        expect(p.reminders[19]!.text).toContain("देय तिथि 20 तारीख है");
        for (const t of [...p.reminders, p.dueTodayTpl, p.overdueTpl]) {
            expect(t.text).toContain("8796278200 – iTarang Technologies LLP");
            expect(t.text).toContain("अनदेखा करें");
        }
        expect(p.receivedTpl.text).not.toContain("अनदेखा");
        expect(p.dueTodayTpl.text).toContain("आज देय है");
    });
});

describe("smsStepFor", () => {
    const p = defaultSmsPlan();
    it("reminders only on the chosen days before", () => {
        expect(smsStepFor(-7, p)).toEqual({ kind: "sms_before", ref: "b7" });
        expect(smsStepFor(-5, p)).toEqual({ kind: "sms_before", ref: "b5" });
        expect(smsStepFor(-1, p)).toEqual({ kind: "sms_before", ref: "b1" });
        expect(smsStepFor(-3, p)).toBeNull();
        expect(smsStepFor(-8, p)).toBeNull();
    });
    it("the due day", () => {
        expect(smsStepFor(0, p)).toEqual({ kind: "sms_due_today", ref: "" });
        expect(smsStepFor(0, { ...p, dueToday: false })).toBeNull();
    });
    it("overdue daily, up to stopAfter", () => {
        expect(smsStepFor(1, p)).toEqual({ kind: "sms_overdue", ref: "o1" });
        expect(smsStepFor(30, p)).toEqual({ kind: "sms_overdue", ref: "o30" });
        expect(smsStepFor(31, p)).toBeNull();
        expect(smsStepFor(5, { ...p, overdue: { ...p.overdue, on: false } })).toBeNull();
    });
    it("overdue every N days from day 1", () => {
        const q = { ...p, overdue: { ...p.overdue, mode: "every" as const, every: 3, stopAfter: 10 } };
        expect(overdueSendDays(q)).toEqual([1, 4, 7, 10]);
    });
    it("overdue on listed days", () => {
        const q = { ...p, overdue: { ...p.overdue, mode: "days" as const, days: [1, 3, 7, 15], stopAfter: 10 } };
        expect(overdueSendDays(q)).toEqual([1, 3, 7]);
    });
});

describe("smsTemplateFor", () => {
    const p = defaultSmsPlan();
    it("a reminder uses the EMI's own due day (30 Nov → day 30, not 31)", () => {
        expect(smsTemplateFor("sms_before", "2026-11-20", p)).toBe(p.reminders[19]);
        expect(smsTemplateFor("sms_before", "2026-11-30", p)).toBe(p.reminders[29]);
    });
    it("the other steps", () => {
        expect(smsTemplateFor("sms_due_today", "2026-11-20", p)).toBe(p.dueTodayTpl);
        expect(smsTemplateFor("sms_overdue", "2026-11-20", p)).toBe(p.overdueTpl);
        expect(smsTemplateFor("received", "2026-11-20", p)).toBe(p.receivedTpl);
    });
});

describe("filling and DLT form", () => {
    it("the DLT text has {#var#} for the financer and {#numeric#} for the amount", () => {
        const t = toDltText(defaultSmsPlan().reminders[20]!.text);
        expect(t).toContain("आपकी {#var#} लोन की EMI ₹{#numeric#} की देय तिथि 21 तारीख है");
        expect(toDltText(defaultSmsPlan().receivedTpl.text)).toContain("दिनांक {#alphanumeric#} को आपकी EMI ₹{#numeric#}");
    });
    it("fills digits-only amounts, a dashless date and a lender cut to 30 characters", () => {
        const v = smsValues({ lender: "A Very Long Financer Name Private Limited", amount: "4,250", paid_date: "05-11-2026" });
        expect(fillText("{lender}|{amount}|{paid_date}", v)).toBe("A Very Long Financer Name Priv|4250|05Nov2026");
    });
});

describe("normalise / window / lenders", () => {
    it("bad stored values fall back to the defaults; days cleaned", () => {
        const p = normaliseSmsPlan({ beforeDays: [1, 7, 7, 40, "5"], overdue: { mode: "weekly", every: 99, stopAfter: 0 } });
        expect(p.beforeDays).toEqual([7, 5, 1]);
        expect(p.overdue.mode).toBe("daily");
        expect(p.overdue.every).toBe(3);
        expect(p.overdue.stopAfter).toBe(30);
        expect(p.reminders[0]!.text).toContain("देय तिथि 1 तारीख");
    });
    it("cleanDays reads a typed list", () => {
        expect(cleanDays("7, 5,1  x 0", 1, 30)).toEqual([7, 5, 1]);
    });
    it("window covers the furthest step each side", () => {
        expect(smsWindow(defaultSmsPlan())).toEqual({ maxOverdue: 30, maxBefore: 7 });
    });
    it("lendersOn lists the financers on a channel", () => {
        const s = { lenders: { a: { sms: true, whatsapp: false }, b: { sms: false, whatsapp: true }, c: { sms: true, whatsapp: true } } };
        expect(lendersOn(s, "sms")).toEqual(["a", "c"]);
        expect(lendersOn(s, "whatsapp")).toEqual(["b", "c"]);
    });
});
