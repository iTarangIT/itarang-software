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
        // ID 90 — the MORE group is gone: news sits under REPORTS.
        expect(out.filter((g) => g.section === "MORE")).toHaveLength(0);
        expect(out.find((g) => g.section === "REPORTS")?.items.map((i) => i.id)).toContain("ceo-news");
    });

    it("CEO: counts only on what the CEO decides; money pages under MONEY (IDs 90, 89)", () => {
        const withBadge = (id: string, badge: number) => ({ ...item(id), badge });
        const out = applyNavLayout(NAV_LAYOUTS.ceo, [
            { section: "OVERVIEW", items: [item("dashboard")] },
            {
                section: "X",
                items: [
                    withBadge("ceo-quotations", 3),
                    withBadge("kyc-review", 5),
                    withBadge("sh-ecofy", 7),
                    item("buyback-dashboard"),
                    withBadge("buyback-negotiations", 2),
                    item("revenue-costs"),
                    item("sales-invoices"),
                ],
            },
        ]);
        const flat = out.flatMap((g) => g.items.flatMap((i) => [i, ...(i.children ?? [])]));
        const badgeOf = (id: string) => flat.find((i) => i.id === id)?.badge;
        expect(badgeOf("ceo-quotations")).toBe(3);
        expect(badgeOf("kyc-review")).toBeUndefined();
        expect(badgeOf("sh-ecofy")).toBeUndefined();
        expect(badgeOf("buyback-negotiations")).toBeUndefined();
        const money = out.find((g) => g.section === "MONEY");
        expect(ids([money!])).toEqual(expect.arrayContaining(["revenue-costs", "ceo-receivables", "sales-invoices"]));
    });

    it("Admin keeps its work-queue counts", () => {
        const out = applyNavLayout(NAV_LAYOUTS.admin, [
            { section: "R", items: [{ ...item("kyc-review"), badge: 4 }, { ...item("buyback-notifications"), badge: 9 }] },
        ]);
        const flat = out.flatMap((g) => g.items.flatMap((i) => [i, ...(i.children ?? [])]));
        expect(flat.find((i) => i.id === "kyc-review")?.badge).toBe(4);
        expect(flat.find((i) => i.id === "buyback-notifications")?.badge).toBeUndefined();
    });
});

// ── ID 90 — the real menus: length, folding, one name, nothing lost ─────────
// Built from sidebar.tsx's own role menus (assembleRoleMenu), so a page added
// there is checked here without anyone restating it.

import { assembleRoleMenu } from "@/components/layout/sidebar";
import { defaultMenuLines, groupStartsOpen, menuHrefs } from "@/components/layout/SidebarRedesign";

type AnyItem = { id: string; label: string; href: string; children?: AnyItem[] };
const sourceOf = (role: string) => assembleRoleMenu(role) as Array<{ section: string; items: AnyItem[] }>;
/** Every page a role's menu reached before the layout: rows, and a node's rows (a node is not a route). */
const reachable = (src: Array<{ items: AnyItem[] }>, hide: string[]) =>
    src.flatMap((g) =>
        g.items
            .filter((i) => !hide.includes(i.id))
            .flatMap((i) => (i.children?.length ? i.children.filter((c) => !hide.includes(c.id)).map((c) => c.href) : [i.href])),
    );
const labels = (groups: RedesignGroup[]): string[] => groups.flatMap((g) => g.items.flatMap((i) => [i.label, ...(i.children ?? []).map((c) => c.label)]));

// The spec's targets, lines shown by default (29 Sep, "Menu length").
const TARGET: Record<string, number> = { ceo: 20, admin: 22, sales_head: 22 };

describe.each(Object.keys(TARGET))("ID 90 — %s menu from the real role menu", (role) => {
    const layout = NAV_LAYOUTS[role];
    const src = sourceOf(role);
    const out = applyNavLayout(layout, src);

    it(`shows at most ${TARGET[role]} lines by default`, () => {
        expect(defaultMenuLines(out)).toBeLessThanOrEqual(TARGET[role]);
    });

    it("keeps every page the role could reach (hidden duplicates only excepted)", () => {
        const have = new Set(menuHrefs(out));
        const hidden = layout.hide ?? [];
        // A hidden duplicate's page must still be reachable unless it is the retired screen.
        const missing = reachable(src, hidden).filter((h) => !have.has(h));
        expect(missing).toEqual([]);
    });

    it("folds every group but HOME, the layout's default-open groups and the current page's", () => {
        for (const g of out) {
            expect(groupStartsOpen(g, null)).toBe(Boolean(g.fixed || g.defaultOpen));
        }
        // Opening a page inside a folded group opens that group.
        const folded = out.find((g) => !g.fixed && !g.defaultOpen)!;
        const deep = folded.items[0].children?.[0] ?? folded.items[0];
        expect(groupStartsOpen(folded, deep.id)).toBe(true);
    });

    it("names the shared screen one way: 'Sales dashboard'", () => {
        // /sales-head, /admin and /admin/reports/sales-dashboard all render
        // SalesHeadOpsView (ID 88); every row that opens it reads the same.
        const SCREEN = ["/sales-head", "/admin", "/admin/reports/sales-dashboard"];
        const rows = out.flatMap((g) => g.items.flatMap((i) => [i, ...(i.children ?? [])])).filter((i) => SCREEN.includes(i.href));
        expect(rows.length).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.label))).toEqual(new Set(["Sales dashboard"]));
        const all = labels(out);
        for (const old of ["Sales Dashboard", "Sales Head dashboard", "Ops Dashboard", "Ops dashboard"]) {
            expect(all).not.toContain(old);
        }
    });
});

describe("ID 90 — CEO menu shape", () => {
    const out = applyNavLayout(NAV_LAYOUTS.ceo, sourceOf("ceo"));
    it("has no MORE group, and news / settings stay reachable", () => {
        expect(out.find((g) => g.section === "MORE")).toBeUndefined();
        const hrefs = menuHrefs(out);
        expect(hrefs).toEqual(expect.arrayContaining(["/ceo/news", "/admin/settings/time-limits", "/ceo/receivables"]));
    });
    it("TEAM folds and unfolds (it starts folded, and holds the Sales dashboard)", () => {
        const team = out.find((g) => g.section === "TEAM")!;
        expect(groupStartsOpen(team, null)).toBe(false);
        expect(team.items[0].label).toBe("Sales dashboard");
        expect(groupStartsOpen(team, team.items[0].id)).toBe(true);
    });
});
