"use client";

// The left menu of the CRM Reporting & Dashboards redesign, for the CEO and
// for Admin and the Sales Head (one shared menu, ID 90): text-only rows under a fixed HOME group and collapsible
// groups whose folded header says what is inside (page count, summed queue
// count, NEW).
//
// It does NOT own the menu's content. sidebar.tsx still builds each role's
// items and attaches every live badge; NAV_LAYOUTS below only says where each
// existing item (by id) sits in the new grouping, so a link, its route, its
// badge and its `nav-…` test id stay defined in one place. An item the layout
// does not mention lands in a trailing MORE group — a page can never drop out
// of the menu because someone forgot to place it here.

import React, { useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Search } from "lucide-react";

import { cn } from "@/lib/utils";

type Badge = number | string;

/** `exact` is read by getActiveItemId in sidebar.tsx (exact-path match only). */
export type RedesignChild = { id: string; label: string; href: string; badge?: Badge; exact?: boolean };
export type RedesignItem = RedesignChild & { isNew?: boolean; urgent?: boolean; children?: RedesignChild[] };
export type RedesignGroup = { section: string; fixed?: boolean; defaultOpen?: boolean; items: RedesignItem[] };

/** What sidebar.tsx hands over: its role menu after every badge pass. */
type SourceItem = { id: string; label: string; href: string; badge?: Badge; exact?: boolean; children?: SourceItem[] };
type SourceGroup = { section: string; items: SourceItem[] };

type Flags = { label?: string; isNew?: boolean; urgent?: boolean };
type Ref =
    | string
    /** An existing item, relabelled or flagged. */
    | ({ id: string } & Flags)
    /** A new folder made of existing items (or pages with no menu entry). */
    | ({ node: string; children: Array<string | ({ id: string } & Flags) | AddRef> } & Flags)
    /** The children of an existing folder, laid out as rows of the group. */
    | { spread: string }
    /** Everything still unplaced from one of the role's original sections. */
    | { section: string }
    /** A page that exists but had no menu entry. */
    | AddRef;
type AddRef = { add: string; label: string; href: string; isNew?: boolean };

type LayoutGroup = { section: string; fixed?: boolean; defaultOpen?: boolean; items: Ref[] };
type Layout = { roleLabel: string; hide?: string[]; groups: LayoutGroup[] };

const BUYBACK: Ref = {
    node: "Buyback",
    children: [
        { id: "buyback-dashboard", label: "Dashboard" },
        { id: "buyback-queue", label: "Requests" },
        "buyback-negotiations",
        "buyback-payments",
        "buyback-vendors",
        "buyback-catalog",
        "buyback-documents",
        "buyback-ledger",
        "buyback-statements",
        "buyback-notifications",
    ],
};
const NEODOVE: Ref = {
    node: "NeoDove",
    children: ["neodove-campaigns", "neodove-activity", "neodove-reconcile"],
};

/**
 * Tracker ID 90 — ONE menu for Admin and Sales Head ("Admin and Sales Head see
 * the same", 29 Sep). The two roles' source menus in sidebar.tsx still use
 * their own id prefixes (`sh-…` / `admin-…`) because badges, test ids and a
 * few hrefs key on them, so every row below names both spellings: leaf() skips
 * an id the role does not have. That is also how admin-only pages (Invoice
 * Ledger, OEM prices) appear for Admin only, and Sales-Head-only ones
 * (Approvals, NBFC, Ecofy, E-commerce) for the Sales Head only — access is
 * still decided by sidebar.tsx's role menus and the route gates, never here.
 *
 * Trimmed by folding, not removing: every page either role could reach before
 * is still a row, a row inside a folder, or (if this layout forgot it) in the
 * trailing MORE group. Menu search covers the folded rows too.
 */
const both = (suffix: string) => [`sh-${suffix}`, `admin-${suffix}`];
const bothAs = (suffix: string, flags: Flags) => both(suffix).map((id) => ({ id, ...flags }));

const ADMIN_SALES_HEAD_GROUPS: LayoutGroup[] = [
    { section: "HOME", fixed: true, items: [{ id: "dashboard", label: "Sales dashboard" }, "sh-ai-analyst"] },
    {
        section: "WORK QUEUES",
        defaultOpen: true,
        items: [
            { id: "approvals", label: "Approvals", urgent: true },
            { node: "Reviews", urgent: true, children: ["kyc-review", "dealer-validation", "product-review"] },
            ...both("escalations"),
            ...both("ready-to-assign"),
            ...both("needs-attention"),
            {
                node: "Lead clean-up",
                children: [
                    ...both("merge-requests"),
                    ...both("number-repair"),
                    ...bothAs("onboarding-dropouts", { label: "Onboarding drop-outs" }),
                ],
            },
        ],
    },
    {
        section: "SALES",
        defaultOpen: true,
        items: [
            ...bothAs("leads", { label: "Leads" }),
            "deals",
            ...both("targets"),
            {
                node: "Lead sourcing",
                children: [
                    ...both("lead-upload"),
                    "sh-ai-campaigns",
                    ...both("ai-intent"),
                    ...both("acquisition-campaigns"),
                    { id: "neodove-campaigns", label: "NeoDove campaigns" },
                    { id: "neodove-activity", label: "NeoDove sync activity" },
                    { id: "neodove-reconcile", label: "NeoDove reconcile" },
                ],
            },
        ],
    },
    {
        section: "DEALERS",
        items: [
            {
                node: "Account management",
                children: [
                    { id: "sh-account-management", label: "Accounts" },
                    { id: "admin-accounts", label: "Accounts" },
                    ...both("dealer-health"),
                ],
            },
            {
                node: "WhatsApp",
                children: [
                    ...bothAs("whatsapp-onboarding", { label: "Onboarding" }),
                    ...bothAs("whatsapp-screenshots", { label: "Screenshots" }),
                ],
            },
        ],
    },
    {
        section: "BATTERY FINANCE",
        items: [
            {
                node: "NBFC",
                children: [
                    { id: "nbfc-directory", label: "Directory" },
                    "nbfc-onboard",
                    "nbfc-my-drafts",
                    { id: "nbfc-risk-cards", label: "Risk cards" },
                ],
            },
            { id: "loan-products", label: "Loan products" },
            {
                node: "Loan calculator",
                children: [
                    ...bothAs("calculator", { label: "Calculator" }),
                    ...bothAs("calculator-history", { label: "Search history" }),
                ],
            },
        ],
    },
    {
        section: "BATTERY LIFECYCLE",
        items: [
            BUYBACK,
            {
                node: "Auction",
                children: [
                    { id: "nbfc-auction-control", label: "Control" },
                    { id: "nbfc-auction-analytics", label: "Performance" },
                ],
            },
            {
                node: "Refurbishment",
                children: [
                    { id: "nbfc-refurb-desk", label: "Jobs" },
                    { id: "nbfc-refurbishers", label: "Refurbishers" },
                ],
            },
            { id: "nbfc-scrap-desk", label: "NBFC scrap purchase" },
        ],
    },
    {
        section: "PRODUCTS & STOCK",
        items: [
            { id: "admin-product-master", label: "Product master" },
            { id: "admin-oem-pricing", label: "OEM prices" },
            {
                node: "Inventory",
                children: [
                    { id: "admin-inventory", label: "Stock" },
                    "admin-inventory-ageing",
                    "admin-inventory-transfer",
                    "admin-inventory-add",
                    "admin-inventory-upload",
                ],
            },
            { id: "sh-ecommerce-products", label: "E-commerce products" },
        ],
    },
    {
        section: "MONEY",
        items: [
            ...bothAs("ai-expense-tracker", { label: "Expense tracker" }),
            "admin-invoice-ledger",
            "submit-expense",
        ],
    },
    // One line, "Ecofy", that opens its pages (spec: "Ecofy collapsed").
    { section: "ECOFY", items: ["sh-ecofy"] },
    {
        section: "REPORTS",
        items: [
            ...bothAs("reports", { isNew: true }),
            {
                node: "Downloads & email reports",
                isNew: true,
                children: [...both("data-downloads"), ...both("scheduled-emails"), ...both("report-catalogue")],
            },
        ],
    },
    {
        section: "SETTINGS",
        items: [
            { id: "sh-settings", label: "Notifications" },
            { id: "admin-settings", label: "Notifications" },
            // ID 155 — a tab on the settings page, given its own row.
            { add: "reporting-lines", label: "Reporting lines", href: "/admin/settings?tab=reporting-lines", isNew: true },
            ...both("kyc-automation"),
            {
                node: "Email reports",
                children: [
                    ...both("sales-daily-digest"),
                    ...both("buyback-daily-digest"),
                    ...both("dealer-validation-digest"),
                    ...both("kyc-review-digest"),
                    ...both("scrap-buyback-digest"),
                    ...both("idle-weekly-digest"),
                    ...both("targets-pending-digest"),
                ],
            },
            ...both("loan-product-defaults"),
            ...both("nbfc-settings"),
            ...both("whatsapp-settings"),
            ...both("gdrive-mirror"),
            // Anything else the Sales Head's Settings section gains later.
            { section: "Settings" },
        ],
    },
];

export const NAV_LAYOUTS: Record<string, Layout> = {
    ceo: {
        roleLabel: "CEO",
        // ID 88 — /admin is the Sales dashboard now, the same screen as the
        // "Sales dashboard" row; the old Operations Dashboard is off the menu
        // (still at /admin/ops-dashboard, linked from Reports).
        hide: ["ceo-admin-dashboard"],
        groups: [
            { section: "HOME", fixed: true, items: [{ id: "dashboard", label: "Overview" }, "ceo-ai-analyst"] },
            {
                section: "NEEDS YOU",
                defaultOpen: true,
                items: [
                    { id: "ceo-quotations", label: "Quote approvals", urgent: true },
                    { id: "expense-approvals", label: "Expense approvals" },
                    { id: "nbfc-approvals", label: "NBFC approvals" },
                    { id: "financing-offer-approvals", label: "Financing approvals" },
                ],
            },
            {
                section: "BUSINESS",
                defaultOpen: true,
                items: [
                    { id: "revenue-costs", label: "Revenue & costs" },
                    { node: "Invoices", children: [{ id: "sales-invoices", label: "Sales invoices" }, "ceo-invoice-ledger"] },
                    {
                        node: "Account management",
                        children: [{ id: "ceo-accounts", label: "Accounts" }, "ceo-dealer-health"],
                    },
                    "ceo-targets",
                    "deals",
                ],
            },
            {
                section: "TEAM",
                items: [
                    { id: "ceo-sales-dashboard", label: "Sales dashboard" },
                    "leads",
                    "ceo-escalations",
                    { node: "Review queues", children: ["kyc-review", "product-review", "dealer-validation"] },
                    {
                        node: "Lead queues",
                        children: ["ceo-ready-to-assign", "ceo-needs-attention", "ceo-number-repair", "ceo-whatsapp-screenshots"],
                    },
                    {
                        node: "Lead sourcing",
                        children: [
                            "ceo-acquisition-campaigns",
                            { add: "ceo-ai-dialer", label: "AI dialler", href: "/ceo/ai-dialer" },
                            { id: "neodove-campaigns", label: "NeoDove campaigns" },
                            { id: "neodove-activity", label: "NeoDove sync activity" },
                            { id: "neodove-reconcile", label: "NeoDove reconcile" },
                        ],
                    },
                ],
            },
            {
                section: "BATTERY FINANCE",
                items: [
                    { id: "nbfc-directory", label: "NBFC directory" },
                    { id: "loan-products", label: "Loan products" },
                    { id: "nbfc-ecosystem", label: "Ecosystem overview" },
                ],
            },
            { section: "BATTERY LIFECYCLE", items: [BUYBACK, { id: "intellicar", label: "IoT dashboard" }] },
            {
                section: "PRODUCTS & STOCK",
                items: [
                    { id: "product-catalog", label: "Product catalogue" },
                    { id: "oem-pricing", label: "OEM prices" },
                    { id: "inventory-reports", label: "Inventory" },
                ],
            },
            { section: "ECOFY", items: ["sh-ecofy"] },
            {
                section: "REPORTS",
                // ID 91 — the redesign board's REPORTS group.
                items: [
                    { id: "ceo-reports", isNew: true },
                    {
                        node: "Downloads & email reports",
                        isNew: true,
                        children: ["ceo-data-downloads", "ceo-scheduled-emails", "ceo-report-catalogue"],
                    },
                ],
            },
            { section: "MORE", items: ["ceo-news", "feature-requests", "submit-expense"] },
        ],
    },
    // ID 88 — every "Sales dashboard" entry is the one screen (SalesHeadOpsView)
    // at /sales-head, /admin and /admin/reports/sales-dashboard: the HOME row
    // stays, the duplicates (and the retired Ops Dashboard row) are hidden.
    sales_head: {
        roleLabel: "Sales Head",
        hide: ["sh-sales-dashboard", "sh-admin-dashboard"],
        groups: ADMIN_SALES_HEAD_GROUPS,
    },
    admin: {
        roleLabel: "Admin",
        hide: ["admin-sales-dashboard"],
        groups: ADMIN_SALES_HEAD_GROUPS,
    },
};

const strip = (i: SourceItem): RedesignChild => ({ id: i.id, label: i.label, href: i.href, badge: i.badge, exact: i.exact });

/**
 * Regroup a role's menu by its layout. Pure: the items, hrefs, ids and badges
 * are whatever sidebar.tsx computed; only their grouping and labels change.
 */
export function applyNavLayout(layout: Layout, source: SourceGroup[]): RedesignGroup[] {
    const byId = new Map<string, SourceItem>();
    for (const g of source) {
        for (const item of g.items) {
            if (!byId.has(item.id)) byId.set(item.id, item);
            for (const c of item.children ?? []) if (!byId.has(c.id)) byId.set(c.id, c);
        }
    }
    const used = new Set<string>(layout.hide ?? []);
    const take = (id: string): SourceItem | null => {
        const item = byId.get(id);
        if (!item || used.has(id)) return null;
        used.add(id);
        for (const c of item.children ?? []) used.add(c.id);
        return item;
    };
    const leaf = (ref: string | ({ id: string } & Flags)): RedesignItem | null => {
        const id = typeof ref === "string" ? ref : ref.id;
        const flags: Flags = typeof ref === "string" ? {} : ref;
        const item = take(id);
        if (!item) return null;
        return {
            ...strip(item),
            label: flags.label ?? item.label,
            isNew: flags.isNew,
            urgent: flags.urgent,
            children: item.children?.length ? item.children.map(strip) : undefined,
        };
    };

    const groups: RedesignGroup[] = [];
    for (const g of layout.groups) {
        const items: RedesignItem[] = [];
        for (const ref of g.items) {
            if (typeof ref === "string" || "id" in ref) {
                const item = leaf(ref);
                if (item) items.push(item);
            } else if ("node" in ref) {
                const children = ref.children
                    .map((c): RedesignItem | null =>
                        typeof c !== "string" && "add" in c ? { id: c.add, label: c.label, href: c.href, isNew: c.isNew } : leaf(c),
                    )
                    .filter((c): c is RedesignItem => c !== null);
                if (children.length) {
                    items.push({
                        id: `node-${ref.node.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
                        label: ref.label ?? ref.node,
                        href: children[0].href,
                        isNew: ref.isNew,
                        urgent: ref.urgent,
                        children: children.map(({ id, label, href, badge, exact }) => ({ id, label, href, badge, exact })),
                    });
                }
            } else if ("spread" in ref) {
                const node = take(ref.spread);
                for (const c of node?.children ?? []) items.push(strip(c));
            } else if ("section" in ref) {
                for (const item of source.find((s) => s.section === ref.section)?.items ?? []) {
                    const placed = leaf(item.id);
                    if (placed) items.push(placed);
                }
            } else {
                items.push({ id: ref.add, label: ref.label, href: ref.href, isNew: ref.isNew });
            }
        }
        if (items.length) groups.push({ section: g.section, fixed: g.fixed, defaultOpen: g.defaultOpen, items });
    }

    const rest: RedesignItem[] = [];
    for (const g of source) {
        for (const item of g.items) {
            const placed = leaf(item.id);
            if (placed) rest.push(placed);
        }
    }
    if (rest.length) {
        // A layout may name its own MORE group; the leftovers join it.
        const more = groups.find((g) => g.section === "MORE");
        if (more) more.items.push(...rest);
        else groups.push({ section: "MORE", items: rest });
    }
    return groups;
}

const badgeNumber = (b: Badge | undefined) => (b == null ? 0 : typeof b === "number" ? b : Number.parseInt(b, 10) || 0);
const capped = (n: number) => (n > 99 ? "99+" : String(n));

function CountPill({ value, urgent, small = false }: { value: Badge; urgent?: boolean; small?: boolean }) {
    return (
        <span
            className={cn(
                "min-w-[22px] rounded-full px-[7px] py-0.5 text-center font-bold tabular-nums text-white",
                small ? "text-[11px]" : "text-[11.5px]",
                urgent ? "bg-danger" : "bg-white/[0.18]",
            )}
        >
            {value}
        </span>
    );
}

function NewPill() {
    return (
        <span className="rounded-full bg-brand-sky px-[7px] py-0.5 text-[10px] font-bold tracking-[0.04em] text-white">NEW</span>
    );
}

export function RedesignedSidebarNav({
    groups,
    activeItemId,
    roleLabel,
    user,
    loading,
    onNavigate,
}: {
    groups: RedesignGroup[];
    activeItemId: string | null;
    roleLabel: string;
    user: { name?: string | null; email?: string | null } | null | undefined;
    loading: boolean;
    onNavigate?: () => void;
}) {
    const router = useRouter();
    const navId = useId();
    const [query, setQuery] = useState("");
    // Explicit toggles only; anything absent falls back to its default (see
    // SidebarNav in sidebar.tsx for why this is derived rather than stored).
    const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());

    const holdsActive = (item: RedesignItem) =>
        item.id === activeItemId || Boolean(item.children?.some((c) => c.id === activeItemId));
    const isOpen = (key: string, fallback: boolean) => (toggled.has(key) ? (toggled.get(key) as boolean) : fallback);
    const toggle = (key: string, fallback: boolean) =>
        setToggled((prev) => new Map(prev).set(key, !(prev.has(key) ? (prev.get(key) as boolean) : fallback)));

    // Searching flattens the menu to the rows that match.
    const q = query.trim().toLowerCase();
    const matches = useMemo(() => {
        if (!q) return [];
        const out: Array<RedesignChild & { path: string }> = [];
        for (const g of groups) {
            for (const item of g.items) {
                if (item.children?.length) {
                    for (const c of item.children) {
                        if (`${item.label} ${c.label}`.toLowerCase().includes(q)) out.push({ ...c, path: `${g.section} · ${item.label}` });
                    }
                } else if (item.label.toLowerCase().includes(q)) {
                    out.push({ ...item, path: g.section });
                }
            }
        }
        return out;
    }, [groups, q]);

    const go = (href: string) => {
        setQuery("");
        onNavigate?.();
        router.push(href);
    };

    const initials = (user?.name || user?.email || roleLabel)
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();

    return (
        <nav aria-label="Main menu" className="flex min-h-0 flex-1 flex-col gap-2.5 px-3.5 py-[18px] text-[#d6e4ee]">
            <div className="flex items-center justify-between gap-2 border-b border-white/10 px-2 pb-2.5 pt-1">
                <img src="/itarang-logo-white.png" alt="iTarang" className="h-6 w-auto select-none object-contain" draggable={false} />
                <span className="rounded-full bg-info-bg px-[9px] py-[3px] text-[11px] font-bold uppercase tracking-[0.06em] text-brand-navy">
                    {roleLabel}
                </span>
            </div>

            <form
                role="search"
                className="flex min-h-10 items-center gap-2 rounded-[10px] bg-white/[0.08] px-3 focus-within:bg-white/[0.12]"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (!q) return;
                    // A menu match wins; anything else is a dealer lookup.
                    go(matches[0]?.href ?? `/leads?search=${encodeURIComponent(query.trim())}`);
                }}
            >
                <Search className="h-4 w-4 shrink-0 text-[#9fbcd0]" aria-hidden />
                <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Search menu or find a dealer"
                    placeholder="Search menu or find a dealer"
                    className="min-w-0 grow border-0 bg-transparent text-[13px] text-white outline-none placeholder:text-[#9fbcd0]"
                />
            </form>

            <div className="sidebar-scroll -mx-1 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-1">
                {q ? (
                    <div className="flex flex-col gap-0.5">
                        {matches.map((m) => (
                            <Link
                                key={m.id}
                                href={m.href}
                                onClick={() => {
                                    setQuery("");
                                    onNavigate?.();
                                }}
                                data-testid={`nav-${m.id}`}
                                className="flex min-h-10 flex-col justify-center rounded-[9px] px-2.5 py-1 hover:bg-white/[0.08]"
                            >
                                <span className="text-[13.5px] font-medium text-[#d6e4ee]">{m.label}</span>
                                <span className="text-[11px] text-[#7fa3bd]">{m.path}</span>
                            </Link>
                        ))}
                        <button
                            type="button"
                            onClick={() => go(`/leads?search=${encodeURIComponent(query.trim())}`)}
                            className="mt-1 rounded-[9px] px-2.5 py-2 text-left text-[13px] text-[#9fbcd0] hover:bg-white/[0.08]"
                        >
                            Find a dealer matching &ldquo;{query.trim()}&rdquo;
                        </button>
                    </div>
                ) : (
                    groups.map((g) => {
                        const open = g.fixed || isOpen(g.section, Boolean(g.defaultOpen) || g.items.some(holdsActive));
                        const pages = g.items.reduce((a, it) => a + (it.children?.length || 1), 0);
                        const itemCount = (it: RedesignItem) =>
                            it.children?.length ? it.children.reduce((a, c) => a + badgeNumber(c.badge), 0) : badgeNumber(it.badge);
                        const sum = g.items.reduce((a, it) => a + itemCount(it), 0);
                        const urgent = g.items.some((it) => it.urgent && itemCount(it) > 0);
                        const panelId = `${navId}-${g.section.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
                        return (
                            <div key={g.section} className="flex flex-col gap-0.5">
                                {g.fixed ? (
                                    <span className="flex min-h-[30px] items-center px-2.5 text-[11px] font-bold tracking-[0.1em] text-[#7fa3bd]">
                                        {g.section}
                                    </span>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => toggle(g.section, open)}
                                        aria-expanded={open}
                                        aria-controls={panelId}
                                        className="flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-left text-[11px] font-bold tracking-[0.1em] text-[#7fa3bd] hover:bg-white/[0.05]"
                                    >
                                        <span className="grow">
                                            {g.section}{" "}
                                            {!open && <span className="font-medium tracking-normal text-[#9fbcd0]">· {pages} pages</span>}
                                        </span>
                                        {!open && g.items.some((it) => it.isNew) && <NewPill />}
                                        {!open && sum > 0 && <CountPill value={capped(sum)} urgent={urgent} />}
                                        <ChevronRight
                                            aria-hidden
                                            className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-200", open && "rotate-90")}
                                            strokeWidth={2.25}
                                        />
                                    </button>
                                )}
                                {open && (
                                    <div id={panelId} className="flex flex-col gap-0.5">
                                        {g.items.map((it) => {
                                            if (it.children?.length) {
                                                const count = itemCount(it);
                                                const nodeOpen = isOpen(it.id, holdsActive(it));
                                                return (
                                                    <div key={it.id} className="flex flex-col gap-0.5">
                                                        <button
                                                            type="button"
                                                            onClick={() => toggle(it.id, nodeOpen)}
                                                            aria-expanded={nodeOpen}
                                                            data-testid={`nav-${it.id}`}
                                                            className="flex min-h-9 items-center gap-2 rounded-[9px] px-2.5 text-left text-[13.5px] font-medium text-[#d6e4ee] hover:bg-white/[0.08]"
                                                        >
                                                            <span className="grow truncate">{it.label}</span>
                                                            {it.isNew && <NewPill />}
                                                            {count > 0 && <CountPill value={capped(count)} urgent={it.urgent} />}
                                                            <ChevronRight
                                                                aria-hidden
                                                                className={cn(
                                                                    "h-3.5 w-3.5 shrink-0 text-[#7fa3bd] transition-transform duration-200",
                                                                    nodeOpen && "rotate-90",
                                                                )}
                                                                strokeWidth={2.25}
                                                            />
                                                        </button>
                                                        {nodeOpen && (
                                                            <div className="ml-3 flex flex-col gap-0.5 border-l border-white/[0.12] pl-2.5">
                                                                {it.children.map((c) => {
                                                                    const active = c.id === activeItemId;
                                                                    return (
                                                                        <Link
                                                                            key={c.id}
                                                                            href={c.href}
                                                                            onClick={onNavigate}
                                                                            data-testid={`nav-${c.id}`}
                                                                            aria-current={active ? "page" : undefined}
                                                                            className={cn(
                                                                                "flex min-h-8 items-center gap-2 rounded-lg px-2 text-[13px]",
                                                                                active
                                                                                    ? "bg-white/[0.14] font-bold text-white"
                                                                                    : "text-[#b9cfde] hover:bg-white/[0.08]",
                                                                            )}
                                                                        >
                                                                            <span className="grow truncate">{c.label}</span>
                                                                            {c.badge ? <CountPill value={c.badge} small /> : null}
                                                                        </Link>
                                                                    );
                                                                })}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            }
                                            const active = it.id === activeItemId;
                                            return (
                                                <Link
                                                    key={it.id}
                                                    href={it.href}
                                                    onClick={onNavigate}
                                                    data-testid={`nav-${it.id}`}
                                                    aria-current={active ? "page" : undefined}
                                                    className={cn(
                                                        "flex min-h-9 items-center gap-2 rounded-[9px] px-2.5 text-[13.5px]",
                                                        active ? "bg-white/[0.14] font-bold text-white" : "font-medium text-[#d6e4ee] hover:bg-white/[0.08]",
                                                    )}
                                                >
                                                    <span className="grow truncate">{it.label}</span>
                                                    {it.isNew && <NewPill />}
                                                    {it.badge ? <CountPill value={it.badge} urgent={it.urgent} /> : null}
                                                </Link>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>

            <div className="flex items-center gap-2.5 border-t border-white/10 px-2 pt-3">
                {loading && !user ? (
                    <div className="h-[34px] w-[34px] animate-pulse rounded-full bg-white/10" />
                ) : (
                    <>
                        <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-brand-sky text-[13px] font-bold text-white">
                            {initials}
                        </span>
                        <span className="flex min-w-0 flex-col gap-px">
                            <span className="truncate text-[13px] font-semibold text-white">{user?.name || roleLabel}</span>
                            <span className="truncate text-[11.5px] text-[#9fbcd0]">Signed in · {roleLabel}</span>
                        </span>
                    </>
                )}
            </div>
        </nav>
    );
}
