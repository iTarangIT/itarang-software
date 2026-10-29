import { describe, expect, it } from "vitest";
import {
    approveText,
    daysBetween,
    defaultEmiMessagesSettings,
    dueKindsFor,
    editText,
    fillText,
    fmtDay,
    mobile10,
    templateParams,
    textFields,
    unknownFields,
} from "@/lib/emi-messages/rules";

const approvedAll = () => {
    const s = defaultEmiMessagesSettings();
    for (const k of Object.keys(s.messages) as Array<keyof typeof s.messages>) {
        s.messages[k] = approveText(s.messages[k]);
    }
    return s;
};

describe("defaults (ID 204)", () => {
    it("ship off, no pilot, nothing approved", () => {
        const s = defaultEmiMessagesSettings();
        expect(s.enabled).toBe(false);
        expect(s.pilotNbfcId).toBeNull();
        expect(Object.values(s.messages).every((m) => m.text === null && !!m.pendingText)).toBe(true);
    });
    it("draft texts use only known fields", () => {
        for (const m of Object.values(defaultEmiMessagesSettings().messages)) {
            expect(unknownFields(m.pendingText!)).toEqual([]);
        }
    });
});

describe("dueKindsFor", () => {
    const s = approvedAll();
    const due = "2026-11-05";
    it("3 days before, the due day, overdue 1 / 3 / 7", () => {
        expect(dueKindsFor({ dueDate: due, unpaid: true }, "2026-11-02", s.messages)).toEqual(["due_3d"]);
        expect(dueKindsFor({ dueDate: due, unpaid: true }, "2026-11-05", s.messages)).toEqual(["due_today"]);
        expect(dueKindsFor({ dueDate: due, unpaid: true }, "2026-11-06", s.messages)).toEqual(["overdue_1"]);
        expect(dueKindsFor({ dueDate: due, unpaid: true }, "2026-11-08", s.messages)).toEqual(["overdue_3"]);
        expect(dueKindsFor({ dueDate: due, unpaid: true }, "2026-11-12", s.messages)).toEqual(["overdue_7"]);
        expect(dueKindsFor({ dueDate: due, unpaid: true }, "2026-11-04", s.messages)).toEqual([]);
    });
    it("nothing for a paid EMI", () => {
        expect(dueKindsFor({ dueDate: due, unpaid: false }, "2026-11-06", s.messages)).toEqual([]);
    });
    it("nothing for a message switched off or not approved", () => {
        const off = approvedAll();
        off.messages.due_today.on = false;
        expect(dueKindsFor({ dueDate: due, unpaid: true }, due, off.messages)).toEqual([]);
        const draft = defaultEmiMessagesSettings();
        expect(dueKindsFor({ dueDate: due, unpaid: true }, due, draft.messages)).toEqual([]);
    });
    it("follows a changed day", () => {
        const s2 = approvedAll();
        s2.messages.due_3d.day = -5;
        expect(dueKindsFor({ dueDate: due, unpaid: true }, "2026-10-31", s2.messages)).toEqual(["due_3d"]);
    });
});

describe("text edits wait for approval", () => {
    const base = approveText(defaultEmiMessagesSettings().messages.due_today);
    it("a new text is pending; the approved one keeps sending", () => {
        const e = editText(base, "नया {name}");
        expect(e.text).toBe(base.text);
        expect(e.pendingText).toBe("नया {name}");
        expect(approveText(e).text).toBe("नया {name}");
        expect(approveText(e).pendingText).toBeNull();
    });
    it("saving the approved text unchanged clears pending", () => {
        expect(editText({ ...base, pendingText: "x" }, base.text!).pendingText).toBeNull();
    });
});

describe("fields", () => {
    const text = "नमस्ते {name}, ₹{amount} {due_date} – {lender} {name}";
    it("in order, repeats kept (WhatsApp body parameters)", () => {
        expect(textFields(text)).toEqual(["name", "amount", "due_date", "lender", "name"]);
        expect(templateParams(text, { name: "Ram", amount: "4,250", due_date: "05-11-2026", lender: "X" })).toEqual([
            "Ram",
            "4,250",
            "05-11-2026",
            "X",
            "Ram",
        ]);
    });
    it("fills, with - for a missing value", () => {
        expect(fillText("{name} {amount}", { name: "Ram" })).toBe("Ram -");
    });
    it("flags unknown fields", () => {
        expect(unknownFields("{name} {emi_no} {emi_no}")).toEqual(["emi_no"]);
    });
});

describe("helpers", () => {
    it("daysBetween / fmtDay / mobile10", () => {
        expect(daysBetween("2026-10-31", "2026-11-05")).toBe(5);
        expect(fmtDay("2026-11-05")).toBe("05-11-2026");
        expect(mobile10("+91 98765 43210")).toBe("9876543210");
        expect(mobile10("12345")).toBeNull();
        expect(mobile10("0123456789")).toBeNull();
    });
});
