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

// ── Leads page: Back undoes the last filter first ─────────────────────────
// Each applied filter state (its query string) is a step. Back drops the
// newest step and restores the one before; with one step left, Back leaves
// the page (previousPage / roleHome). Kept per tab in sessionStorage so the
// steps survive opening a lead and coming back.

export const FILTER_STEPS_KEY = "itarang.leadsFilterSteps";
const MAX_FILTER_STEPS = 50;

/** Add the newly applied state; the same state twice in a row is one step. */
export function pushFilterStep(steps: string[], qs: string): string[] {
    if (steps[steps.length - 1] === qs) return steps;
    return [...steps, qs].slice(-MAX_FILTER_STEPS);
}

/** Undo the newest filter: the state to restore, or null when none is left. */
export function popFilterStep(steps: string[]): { steps: string[]; restore: string | null } {
    if (steps.length < 2) return { steps, restore: null };
    const next = steps.slice(0, -1);
    return { steps: next, restore: next[next.length - 1] };
}

/**
 * The saved steps belong to this visit only when they end at the state the
 * page opened on (coming back from a lead); a fresh visit starts over.
 */
export function resumeFilterSteps(saved: string[], openedOn: string): string[] {
    return saved.length > 0 && saved[saved.length - 1] === openedOn ? saved : [openedOn];
}

export function readFilterSteps(): string[] {
    try {
        const v = JSON.parse(window.sessionStorage.getItem(FILTER_STEPS_KEY) ?? "[]");
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
        return [];
    }
}

export function writeFilterSteps(steps: string[]): void {
    try {
        window.sessionStorage.setItem(FILTER_STEPS_KEY, JSON.stringify(steps));
    } catch {
        /* storage blocked: steps live only while the page is open */
    }
}
