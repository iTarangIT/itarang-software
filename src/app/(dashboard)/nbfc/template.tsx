import type { ReactNode } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentTenant, getSessionUser } from "@/lib/nbfc/tenant";
import { getPortalAccess } from "@/lib/nbfc/approval-hierarchy";
import { firstAllowedHref, isPathAllowed } from "@/lib/nbfc/portal-nav";

/**
 * E-388 — NBFC portal page guard. A template (unlike the layout) renders again
 * on every navigation, so this runs for each page the user opens. When the
 * NBFC admin has not ticked the menu a page belongs to (Settings → Users →
 * Menus), the page is not rendered: the user goes to the first menu they do
 * have, or sees a short notice when there is none.
 *
 * The path comes from the x-nbfc-pathname header the middleware sets.
 */
export const dynamic = "force-dynamic";

export default async function NbfcTemplate({ children }: { children: ReactNode }) {
  const pathname = (await headers()).get("x-nbfc-pathname");
  if (!pathname) return <>{children}</>;

  const session = await getSessionUser();
  if (!session) return <>{children}</>;
  const tenant = await getCurrentTenant();
  const { allowedNav } = await getPortalAccess(tenant.id, session.id);
  if (allowedNav == null) return <>{children}</>;

  // The landing page has no menu of its own — send a restricted user straight
  // to their first allowed menu.
  const first = firstAllowedHref(allowedNav);
  if (pathname === "/nbfc" && first) redirect(first);
  if (isPathAllowed(allowedNav, pathname)) return <>{children}</>;
  if (first) redirect(first);

  return (
    <div className="mx-auto max-w-lg rounded-xl border border-slate-200 bg-white px-6 py-10 text-center">
      <p className="text-sm font-semibold text-slate-700">You don&apos;t have access to this page.</p>
      <p className="mt-1 text-xs text-slate-500">
        Your NBFC admin decides which menus you can open (Settings → Users).
      </p>
      <Link href="/nbfc/profile" className="mt-4 inline-block text-xs font-semibold text-[color:var(--color-brand-sky)] hover:underline">
        Go to my profile
      </Link>
    </div>
  );
}
