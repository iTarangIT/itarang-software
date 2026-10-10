import { describe, expect, it } from "vitest";
import { NAV_LAYOUTS, applyNavLayout, type RedesignGroup } from "@/components/layout/SidebarRedesign";

// Tracker ID 90 — Admin and Sales Head share one menu. The layout regroups the
// role's own items; it must never drop one, never invent a role's page, and
// must hide the duplicate "Sales dashboard" rows (ID 88).

type Src = { section: string; items: Array<{ id: string; label: string; href: string; children?: Array<{ id: string; label: string; href: string }> }> };
const item = (id: string, children?: string[]) => ({
    id,
    label: id,
    href: `/${id}`,
    children: children?.map((c) => ({ id: c, label: c, href: `/${c}` })),
});

const ids = (groups: RedesignGroup[]) =>
    groups.flatMap((g) => g.items.flatMap((i) => (i.children?.length && !i.id.startsWith("node-") ? [i.id, ...i.children.map((c) => c.id)] : i.children?.length ? i.children.map((c) => c.id) : [i.id])));

const ADMIN_SOURCE: Src[] = [
    { section: "OVERVIEW", items: [item("dashboard")] },
    {
        section: "LEAD MANAGEMENT",
        items: [
            "admin-leads",
            "admin-escalations",
            "admin-merge-requests",
            "admin-onboarding-dropouts",
            "admin-whatsapp-onboarding",
            "admin-lead-upload",
            "admin-acquisition-campaigns",
            "admin-sales-dashboard",
            "admin-targets",
            "admin-ready-to-assign",
            "admin-needs-attention",
            "admin-number-repair",
            "admin-whatsapp-screenshots",
            "admin-dealer-health",
            "admin-accounts",
            "admin-invoice-ledger",
            "admin-settings",
            "admin-ai-intent",
            "admin-kyc-automation",
            "admin-sales-daily-digest",
            "admin-gdrive-mirror",
            "some-future-admin-page",
        ].map((id) => item(id)),
    },
    { section: "REVIEW", items: [item("kyc-review"), item("product-review")] },
    { section: "INVENTORY", items: [item("admin-inventory"), item("admin-oem-pricing"), item("admin-inventory-add")] },
    { section: "SETTINGS-ish", items: [item("admin-nbfc-settings", ["admin-nbfc-payments", "admin-nbfc-request-sla"])] },
    { section: "EXPENSES", items: [item("submit-expense")] },
];

describe("ID 90 — shared Admin / Sales Head menu", () => {
    it("admin and sales_head use the same groups", () => {
        expect(NAV_LAYOUTS.admin.groups).toBe(NAV_LAYOUTS.sales_head.groups);
    });

    it("keeps every admin page except the hidden duplicate dashboard, once each", () => {
        const out = applyNavLayout(NAV_LAYOUTS.admin, ADMIN_SOURCE);
        const placed = ids(out);
        const expected = ADMIN_SOURCE.flatMap((g) =>
            g.items.flatMap((i) => (i.children ? [i.id, ...i.children.map((c) => c.id)] : [i.id])),
        )
            .filter((id) => id !== "admin-sales-dashboard")
            // ID 155 — the layout's own row for the Reporting lines settings tab.
            .concat("reporting-lines");
        expect(new Set(placed)).toEqual(new Set(expected));
        expect(placed.length).toBe(new Set(placed).size);
        // A page the layout does not know lands in MORE rather than vanishing.
        expect(out.find((g) => g.section === "MORE")?.items.map((i) => i.id)).toContain("some-future-admin-page");
        // Sales-Head-only rows never appear for admin.
        expect(placed).not.toContain("approvals");
        expect(placed).not.toContain("sh-ecofy");
    });

    it("names the home row 'Sales dashboard' for admin and sales head", () => {
        const out = applyNavLayout(NAV_LAYOUTS.sales_head, [
            { section: "OVERVIEW", items: [item("dashboard")] },
            { section: "LM", items: [item("sh-admin-dashboard"), item("sh-sales-dashboard"), item("sh-leads")] },
        ]);
        expect(out[0].items[0].label).toBe("Sales dashboard");
        expect(ids(out)).not.toContain("sh-admin-dashboard");
        expect(ids(out)).not.toContain("sh-sales-dashboard");
    });

    it("CEO: the Ops dashboard row is gone and the Sales dashboard row is named once", () => {
        const out = applyNavLayout(NAV_LAYOUTS.ceo, [
            { section: "OVERVIEW", items: [item("dashboard")] },
            { section: "PART 0", items: [item("ceo-admin-dashboard"), item("ceo-sales-dashboard"), item("ceo-news")] },
        ]);
        expect(ids(out)).not.toContain("ceo-admin-dashboard");
        const team = out.find((g) => g.section === "TEAM");
        expect(team?.items[0].label).toBe("Sales dashboard");
        expect(out.filter((g) => g.section === "MORE")).toHaveLength(1);
    });
});
