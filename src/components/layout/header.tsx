"use client";

import React, { useState, useRef, useEffect } from 'react';
import { Search, LogOut, User, ChevronDown, Settings, Menu } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { GlobalSearchOverlay } from '@/components/search/GlobalSearchOverlay';
import NotificationBell from '@/components/shared/NotificationBell';
import type { NotificationRole } from '@/lib/notifications/catalog';
// Dependency-free by design (middleware runs it on Edge), so a client component
// can share the one list rather than keep a second copy that drifts.
import { BUYBACK_ADMIN_ROLES } from '@/lib/buyback/roles';
import { useAuth } from '@/components/auth/AuthProvider';
import { useUIStore } from '@/store/uiStore';
import { toast } from 'sonner';

export function Header() {
    const router = useRouter();
    const supabase = createClient();
    const { user } = useAuth();
    // Mobile hamburger → opens the shared nav drawer. Shown on EVERY route this
    // header renders on. It used to be an allowlist of three prefixes
    // (/dealer-portal, /expenses, /it), which left every other role — sales_head,
    // admin, ceo, business_head… — stranded on a phone with the desktop sidebar
    // hidden (md:hidden) and no way to open navigation. The stated reason for the
    // allowlist was exactly that failure mode, so it applies everywhere.
    // /nbfc/* and /risk-head/* never reach here (LayoutWrapper hands them to
    // their own shells, which carry their own hamburgers).
    const openSidebar = useUIStore((s) => s.openSidebar);
    const openChangePassword = useUIStore((s) => s.openChangePassword);
    const [isProfileOpen, setIsProfileOpen] = useState(false);
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const displayName = user?.name || user?.email?.split('@')[0] || 'User';
    const displayEmail = user?.email || '';
    // NOTE: displayRole is sourced from `users.role` via /api/user/profile.
    // If the persona row in DB carries the wrong role (e.g. "dealer" for a
    // sales_head Supabase login), this is a data issue — see
    // docs/nbfc/NOTES.md for the seed-personas fix path.
    const displayRole = user?.role || 'user';
    const initials = displayName.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase();

    // Which portal's "View all notifications" page this viewer belongs on.
    const role = (user?.role ?? '').toLowerCase();
    const portalRole: NotificationRole =
        role === 'scrap_vendor'
            ? 'vendor'
            : role.startsWith('nbfc') || role === 'risk_head'
                ? 'nbfc'
                : BUYBACK_ADMIN_ROLES.includes(role)
                    ? 'admin'
                    : 'dealer';

    const handleLogout = () => {
        if (loggingOut) return;
        setLoggingOut(true);
        setIsProfileOpen(false);
        toast.success('Signed out successfully. Redirecting...');
        // Short delay so the user sees the toast before redirect
        setTimeout(() => {
            // Relative: hits /api/auth/logout on the current public host.
            // The server route uses X-Forwarded-Host to build the correct
            // absolute redirect Location, so we never ship users to the
            // internal upstream (localhost:3003).
            window.location.href = '/api/auth/logout';
        }, 800);
    };

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsProfileOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    return (
        <header
            className="sticky top-0 z-20 px-6 py-3 flex items-center justify-between"
            style={{
                background: "var(--color-surface)",
                borderBottom: "1px solid var(--color-border)",
                boxShadow: "var(--shadow-card)",
            }}
        >
            <GlobalSearchOverlay isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />
            {/* Search Bar */}
            <div className="flex items-center gap-4 flex-1 max-w-2xl">
                <button
                    type="button"
                    onClick={openSidebar}
                    aria-label="Open navigation menu"
                    className="md:hidden p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                    <Menu className="w-6 h-6" />
                </button>
                <img
                    src="/itarang-logo.png"
                    alt="iTarang"
                    className="h-10 w-auto object-contain md:hidden"
                    draggable={false}
                />
                <h2 className="sr-only md:hidden">iTarang</h2>
                <button
                    type="button"
                    onClick={() => setIsSearchOpen(true)}
                    className="relative w-full max-w-md hidden md:block group text-left"
                >
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 group-hover:text-brand-500 transition-colors" />
                    <div className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-transparent rounded-lg text-sm group-hover:bg-white group-hover:border-gray-200 group-hover:shadow-sm transition-all text-gray-500">
                        Search for anything…
                    </div>
                </button>
            </div>

            {/* Right Actions */}
            <div className="flex items-center gap-4">
                {/* Single unified in-app bell. Reads /api/notifications, which
                    returns EVERY notification row addressed to the signed-in
                    user — leads, KYC and consent, the NBFC request loop, FI /
                    VKYC / E-NACH / agreement, product selection, sanction and
                    disbursal, dealer onboarding, inventory, buyback,
                    escalations.

                    Each row arrives with its deep link already resolved for
                    THIS viewer's portal, so portalRole is only needed for the
                    "View all" destination. NBFC users get their bell from
                    NbfcPortalHeader, not here — /nbfc/* renders its own chrome
                    (see LayoutWrapper) — but the role is mapped anyway so a
                    dual-role login lands on the right page. */}
                <NotificationBell portalRole={portalRole} />

                {/* Profile Dropdown */}
                <div className="relative" ref={dropdownRef}>
                    <button
                        onClick={() => setIsProfileOpen(!isProfileOpen)}
                        className="flex items-center gap-2 hover:bg-gray-50 p-1.5 rounded-lg transition-colors focus:outline-none"
                    >
                        <div
                            className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm shadow-sm"
                            style={{ background: "var(--gradient-primary)" }}
                        >
                            {initials}
                        </div>
                        <div className="hidden md:block text-left">
                            <p className="text-sm font-semibold text-gray-900 leading-none">{displayName}</p>
                            <span
                                className="inline-block mt-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-[0.14em] uppercase"
                                style={{
                                    background: "var(--brand-sky-soft)",
                                    color: "var(--color-brand-sky)",
                                }}
                            >
                                {displayRole}
                            </span>
                        </div>
                        <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${isProfileOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {/* Dropdown Menu */}
                    {isProfileOpen && (
                        <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-lg border border-gray-100 py-2 animate-in fade-in slide-in-from-top-2">
                            <div className="px-4 py-2 border-b border-gray-50 md:hidden">
                                <p className="text-sm font-medium text-gray-900">{displayName}</p>
                                <p className="text-xs text-gray-500">{displayEmail}</p>
                            </div>

                            <div className="py-1">
                                <Link
                                    href="/profile"
                                    onClick={() => setIsProfileOpen(false)}
                                    className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-brand-600 transition-colors"
                                >
                                    <User className="w-4 h-4" />
                                    View Profile
                                </Link>
                                <button
                                    type="button"
                                    onClick={() => { setIsProfileOpen(false); openChangePassword(); }}
                                    className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-brand-600 transition-colors"
                                >
                                    <Settings className="w-4 h-4" />
                                    Change Password
                                </button>
                                {/* The "Subscription: Active" item that used to sit here was a
                                    dead button advertising a state that exists nowhere in the
                                    schema. Removed rather than left next to a live one. */}
                            </div>

                            <div className="border-t border-gray-100 my-1"></div>

                            <button
                                onClick={handleLogout}
                                disabled={loggingOut}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <LogOut className="w-4 h-4" />
                                {loggingOut ? 'Signing out…' : 'Logout'}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </header>
    );
}