// ID 222 — the booked visit on "Waiting for a field visit" rows, and its filter.
import { describe, expect, it } from "vitest";

import { fieldVisitDetail, filterVisitBooked, parseVisitBooked } from "@/lib/dashboard/fieldVisitText";

describe("fieldVisitDetail", () => {
    it("GR ENTERPRISE: past the limit and shows the booked date", () => {
        expect(fieldVisitDetail({ transferredOn: "31 Jul", days: 81, lim: 3, booked: "13 Nov" })).toBe(
            "Transferred 31 Jul · 81 working days, no visit · past the limit (3 working days) · visit booked for 13 Nov",
        );
    });
    it("no booking: the line as before", () => {
        expect(fieldVisitDetail({ transferredOn: "03 Nov", days: 1, lim: 3, booked: null })).toBe(
            "Transferred 03 Nov · 1 working day, no visit · within the limit (3 working days)",
        );
    });
});

describe("filterVisitBooked", () => {
    const rows = [
        { lead_id: "GR", visit_booked: "13 Nov" },
        { lead_id: "A", visit_booked: null },
        { lead_id: "B" },
    ];
    it("No visit booked hides GR ENTERPRISE; Visit booked keeps only it; All keeps all", () => {
        expect(filterVisitBooked(rows, "none").map((r) => r.lead_id)).toEqual(["A", "B"]);
        expect(filterVisitBooked(rows, "booked").map((r) => r.lead_id)).toEqual(["GR"]);
        expect(filterVisitBooked(rows, "all")).toHaveLength(3);
    });
    it("parses the URL value, anything else = all", () => {
        expect(parseVisitBooked("none")).toBe("none");
        expect(parseVisitBooked("booked")).toBe("booked");
        expect(parseVisitBooked("x")).toBe("all");
        expect(parseVisitBooked(null)).toBe("all");
    });
});
