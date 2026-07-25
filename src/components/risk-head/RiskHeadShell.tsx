"use client";

/**
 * RiskHeadShell — client chrome for the NBFC Risk Head dashboard (/risk-head).
 *
 * Mirrors `NbfcPortalShell`: a fixed navy sidebar on ≥ md and a slide-in drawer
 * below md, sharing `drawerOpen` between the header hamburger and the sidebar.
 * The header is intentionally lean (tenant identity + logout) — the Risk Head
 * only reviews and signs off on immobilisation requests.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Menu, LogOut, User, Settings, ChevronDown } from "lucide-react";
import RiskHeadSidebar from "@/components/risk-head/RiskHeadSidebar";
import { useUIStore } from "@/store/uiStore";

export default function RiskHeadShell({
  tenantName,
  pendingCount,
  children,
}: {
  tenantName: string;
  pendingCount: number;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const openChangePassword = useUIStore((s) => s.openChangePassword);
  const pathname = usePathname();

  useEffect(() => {
    setDrawerOpen(false);
    setProfileOpen(false);
  }, [pathname]);

  // Close the profile menu on any outside click.
  useEffect(() => {
    if (!profileOpen) return;
    const onClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [profileOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const initials = (
    tenantName
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2) || tenantName.slice(0, 2)
  ).toUpperCase();

  return (
    <div className="flex bg-[color:var(--color-bg)] min-h-screen">
      <RiskHeadSidebar
        tenantName={tenantName}
        pendingCount={pendingCount}
        mobileOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
      <div className="flex-1 md:ml-64 flex flex-col min-h-screen min-w-0">
        <header
          className="sticky top-0 z-20 px-4 sm:px-6 py-3 flex items-center justify-between gap-3"
          style={{
            background: "var(--color-surface)",
            borderBottom: "1px solid var(--color-border)",
            boxShadow: "var(--shadow-card)",
          }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              className="md:hidden -ml-1 p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors shrink-0"
            >
              <Menu className="w-5 h-5" />
            </button>
            <img
              src="/itarang-logo.png"
              alt="iTarang"
              className="h-9 w-auto object-contain md:hidden shrink-0"
              draggable={false}
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900 leading-none truncate">
                {tenantName}
              </p>
              <span
                className="inline-block mt-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-[0.14em] uppercase"
                style={{
                  background: "var(--brand-sky-soft)",
                  color: "var(--color-brand-sky)",
                }}
              >
                Risk Head
              </span>
            </div>
          </div>

          {/* Was avatar + a bare logout link, which left this role with no route
              to a profile or to Change Password at all. */}
          <div className="relative" ref={dropdownRef}>
            <button
              type="button"
              onClick={() => setProfileOpen((v) => !v)}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-50"
              aria-haspopup="menu"
              aria-expanded={profileOpen}
            >
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm shadow-sm"
                style={{ background: "var(--gradient-primary)" }}
                aria-hidden
              >
                {initials}
              </div>
              <ChevronDown
                className={`w-4 h-4 text-slate-400 transition-transform ${profileOpen ? "rotate-180" : ""}`}
              />
            </button>

            {profileOpen && (
              <div className="absolute right-0 mt-2 w-56 rounded-xl border border-gray-100 bg-white py-2 shadow-lg animate-in fade-in slide-in-from-top-2 z-50">
                <div className="py-1">
                  <Link
                    href="/risk-head/profile"
                    onClick={() => setProfileOpen(false)}
                    className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50"
                  >
                    <User className="w-4 h-4" />
                    View Profile
                  </Link>
                  <button
                    type="button"
                    onClick={() => { setProfileOpen(false); openChangePassword(); }}
                    className="flex w-full items-center gap-2 px-4 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50"
                  >
                    <Settings className="w-4 h-4" />
                    Change Password
                  </button>
                </div>
                <div className="my-1 border-t border-gray-100" />
                <a
                  href="/api/auth/logout"
                  className="flex items-center gap-2 px-4 py-2 text-sm text-red-600 transition-colors hover:bg-red-50"
                >
                  <LogOut className="w-4 h-4" />
                  Logout
                </a>
              </div>
            )}
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6 md:p-8 overflow-y-auto">
          <div className="max-w-7xl mx-auto">{children}</div>
        </main>
      </div>
    </div>
  );
}
