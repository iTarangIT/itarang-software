"use client";

/**
 * NbfcPortalShell — client shell for the NBFC partner portal (BRD §6.1.2).
 *
 * The portal layout (`src/app/(dashboard)/nbfc/layout.tsx`) is a server
 * component that resolves the tenant; it delegates the interactive chrome to
 * this client shell so the mobile navigation drawer can share `drawerOpen`
 * state between the header (hamburger) and the sidebar (slide-in drawer).
 *
 * Responsive behaviour:
 *  - ≥ md (768px): fixed navy sidebar, content offset by `md:ml-64`.
 *  - < md: sidebar hidden; a hamburger in the header opens a slide-in drawer.
 */
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import NbfcPortalSidebar from "@/components/nbfc-portal/NbfcPortalSidebar";
import NbfcPortalHeader from "@/components/nbfc-portal/NbfcPortalHeader";

export default function NbfcPortalShell({
  tenantName,
  activeLoans,
  aumInr,
  children,
}: {
  tenantName: string;
  activeLoans: number;
  aumInr: number | null;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Lock body scroll while the drawer is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  // Allow Escape to dismiss the drawer.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div className="flex bg-[color:var(--color-bg)] min-h-screen">
      <NbfcPortalSidebar
        tenantName={tenantName}
        activeLoans={activeLoans}
        aumInr={aumInr}
        mobileOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
      <div className="flex-1 md:ml-64 flex flex-col min-h-screen min-w-0">
        <NbfcPortalHeader
          tenantName={tenantName}
          onMenuClick={() => setDrawerOpen(true)}
        />
        <main className="flex-1 p-4 sm:p-6 md:p-8 overflow-y-auto">
          <div className="max-w-7xl mx-auto">{children}</div>
        </main>
      </div>
    </div>
  );
}
