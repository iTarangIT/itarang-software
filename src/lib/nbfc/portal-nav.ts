/**
 * NBFC portal sidebar menus — one list shared by the sidebar, the page guard
 * (src/app/(dashboard)/nbfc/template.tsx) and Settings → Users menu ticks.
 *
 * E-388 — nbfc_users.allowed_nav: NULL ⇒ every menu; an array ⇒ only those
 * menu ids. Pages that are not under any menu (landing, profile,
 * notifications) are always open. Pure, no I/O.
 */

export const NBFC_NAV = [
  { id: "acquire", href: "/nbfc/acquire", label: "Acquire" },
  { id: "portfolio", href: "/nbfc/portfolio", label: "Portfolio Overview" },
  { id: "leads", href: "/nbfc/leads", label: "Lead Intelligence" },
  { id: "emi-tracker", href: "/nbfc/emi-tracker", label: "EMI Tracker" },
  { id: "batteries", href: "/nbfc/batteries", label: "Battery Monitoring" },
  { id: "risk", href: "/nbfc/risk", label: "Risk Alerts" },
  { id: "recovery-queue", href: "/nbfc/recovery/queue", label: "Recovery" },
  { id: "recovery", href: "/nbfc/recovery", label: "Recovery & Auction" },
  { id: "recovery-batteries", href: "/nbfc/recovery/batteries", label: "Recovered Batteries" },
  { id: "recovery-refurbishment", href: "/nbfc/recovery/refurbishment", label: "Refurbishment" },
  { id: "recovery-scrap", href: "/nbfc/recovery/scrap", label: "Scrap Sales" },
  { id: "auction", href: "/nbfc/auction", label: "Auction Lots" },
  { id: "auction-drafts", href: "/nbfc/auction/drafts", label: "Draft Lots" },
  { id: "audit", href: "/nbfc/audit", label: "Audit Log" },
  { id: "settings", href: "/nbfc/settings", label: "Settings" },
] as const;

export type NbfcNavId = (typeof NBFC_NAV)[number]["id"];

export const NBFC_NAV_IDS: string[] = NBFC_NAV.map((n) => n.id);

/** Default menus for a new child login: only the origination workspace. */
export const CHILD_DEFAULT_NAV: NbfcNavId[] = ["acquire"];
/** Designation shown for a child login when the admin has not set one. */
export const CHILD_DEFAULT_TITLE = "Credit Verifier";
export const DEFAULT_TITLE = "NBFC Partner";

/** Keeps only known menu ids, de-duplicated, in sidebar order. null stays null (= all). */
export function cleanAllowedNav(v: unknown): NbfcNavId[] | null {
  if (v == null) return null;
  const set = new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return NBFC_NAV.map((n) => n.id).filter((id) => set.has(id));
}

/** The menu a path belongs to — the deepest matching href — or null. */
export function navIdForPath(pathname: string): NbfcNavId | null {
  let best: { id: NbfcNavId; len: number } | null = null;
  for (const n of NBFC_NAV) {
    if (pathname === n.href || pathname.startsWith(`${n.href}/`)) {
      if (!best || n.href.length > best.len) best = { id: n.id, len: n.href.length };
    }
  }
  return best?.id ?? null;
}

export function isNavAllowed(allowed: readonly string[] | null, id: string): boolean {
  return allowed == null || allowed.includes(id);
}

export function isPathAllowed(allowed: readonly string[] | null, pathname: string): boolean {
  const id = navIdForPath(pathname);
  return id == null || isNavAllowed(allowed, id);
}

export function firstAllowedHref(allowed: readonly string[] | null): string | null {
  const first = NBFC_NAV.find((n) => isNavAllowed(allowed, n.id));
  return first?.href ?? null;
}
