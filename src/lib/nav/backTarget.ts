// ID 232: '← Back' on the lead pages returns to the page the person came from,
// with its tab and filters (they live in the URL), else to their own home queue.
// Pure — the tab's visit stack lives in sessionStorage (NavHistoryTracker).

export const NAV_STACK_KEY = "itarang.navStack";
const MAX_ENTRIES = 30;

function pathOf(url: string): string {
    const q = url.indexOf("?");
    return q === -1 ? url : url.slice(0, q);
}

/**
 * Record a visit. The same page with a new query (a filter or tab changed in
 * place) replaces its own entry instead of adding one, so Back skips over
 * filter clicks and lands on the latest state of the previous page.
 */
export function pushVisit(stack: string[], url: string): string[] {
    const next = stack.slice();
    const last = next[next.length - 1];
    if (last !== undefined && pathOf(last) === pathOf(url)) next[next.length - 1] = url;
    else next.push(url);
    return next.slice(-MAX_ENTRIES);
}

/** The most recent page in this tab that is not the current one, or null. */
export function previousPage(stack: string[], currentPath: string): string | null {
    for (let i = stack.length - 1; i >= 0; i--) {
        if (pathOf(stack[i]) !== currentPath) return stack[i];
    }
    return null;
}

/** The person's own home queue — the same map the middleware sends them to. */
const ROLE_HOME: Record<string, string> = {
    ceo: "/ceo",
    business_head: "/business-head",
    sales_head: "/sales-head",
    sales_manager: "/sales-manager",
    sales_executive: "/sales-executive",
    inside_sales_rep: "/inside-sales",
    asm: "/asm",
    partner: "/partner/leads",
    admin: "/admin",
};

export function roleHome(role: string | null | undefined): string {
    return ROLE_HOME[role ?? ""] ?? "/";
}

export function readNavStack(): string[] {
    try {
        const raw = window.sessionStorage.getItem(NAV_STACK_KEY);
        const v = raw ? JSON.parse(raw) : [];
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
        return [];
    }
}

export function writeNavStack(stack: string[]): void {
    try {
        window.sessionStorage.setItem(NAV_STACK_KEY, JSON.stringify(stack));
    } catch {
        /* private mode / blocked storage: Back falls back to the home queue */
    }
}
