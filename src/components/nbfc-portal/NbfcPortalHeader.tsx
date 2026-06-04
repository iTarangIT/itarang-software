"use client";

/**
 * NbfcPortalHeader — top header for the NBFC partner portal.
 *
 * Visual language mirrors `src/components/layout/header.tsx` (the admin/CEO
 * header) so the NBFC surface reads as the same product. The profile chip is
 * parameterised for the tenant: it shows the NBFC partner's company name with
 * an "NBFC PARTNER" badge instead of a person's name. The search bar reuses
 * the same global search overlay as the admin header.
 */
import React, { useState, useRef, useEffect } from "react";
import { Search, Bell, LogOut, User, ChevronDown, Settings, CreditCard, Menu, Inbox, MapPin, Video, FileSignature, FileText, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { GlobalSearchOverlay } from "@/components/search/GlobalSearchOverlay";
import { useAuth } from "@/components/auth/AuthProvider";
import { useNbfcWorkQueue } from "@/hooks/useNbfcWorkQueue";
import { toast } from "sonner";

/** Compact "2h ago" style relative time for recent-activity rows. */
function relativeTime(iso: string): string {
    const diffMs = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diffMs / 60_000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
}

export default function NbfcPortalHeader({
    tenantName,
    onMenuClick,
}: {
    tenantName: string;
    onMenuClick?: () => void;
}) {
    const { user } = useAuth();
    const wq = useNbfcWorkQueue();
    const [isProfileOpen, setIsProfileOpen] = useState(false);
    const [isBellOpen, setIsBellOpen] = useState(false);
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const bellRef = useRef<HTMLDivElement>(null);

    // One row per track. Hidden when its count is 0; each deep-links to the
    // Acquire pipeline pre-filtered to exactly the leads that need that action.
    const bellItems = [
        { key: "pending", label: "New applications", count: wq.acquire_pending, href: "/nbfc/acquire?status=pending", icon: Inbox },
        { key: "fi", label: "Field Investigation to review", count: wq.fi, href: "/nbfc/acquire?need=fi", icon: MapPin },
        { key: "vkyc", label: "Video KYC pending", count: wq.vkyc, href: "/nbfc/acquire?need=vkyc", icon: Video },
        { key: "enach", label: "E-NACH pending", count: wq.enach, href: "/nbfc/acquire?need=enach", icon: FileSignature },
        { key: "agreement", label: "Agreement pending", count: wq.agreement, href: "/nbfc/acquire?need=agreement", icon: FileText },
    ];
    const visibleBellItems = bellItems.filter((i) => i.count > 0);

    const displayEmail = user?.email || "";

    // Avatar initials from the company name: "Bajaj Finance Limited" → "BF".
    const words = tenantName.trim().split(/\s+/).filter(Boolean);
    const initials = (
        words.map((w) => w[0]).join("").slice(0, 2) || tenantName.slice(0, 2)
    ).toUpperCase();

    const handleLogout = () => {
        if (loggingOut) return;
        setLoggingOut(true);
        setIsProfileOpen(false);
        toast.success("Signed out successfully. Redirecting...");
        // Short delay so the user sees the toast before redirect
        setTimeout(() => {
            // Relative: hits /api/auth/logout on the current public host.
            // The server route uses X-Forwarded-Host to build the correct
            // absolute redirect Location, so we never ship users to the
            // internal upstream (localhost:3003).
            window.location.href = "/api/auth/logout";
        }, 800);
    };

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsProfileOpen(false);
            }
            if (bellRef.current && !bellRef.current.contains(event.target as Node)) {
                setIsBellOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    return (
        <header
            className="sticky top-0 z-20 px-4 sm:px-6 py-3 flex items-center justify-between gap-3"
            style={{
                background: "var(--color-surface)",
                borderBottom: "1px solid var(--color-border)",
                boxShadow: "var(--shadow-card)",
            }}
        >
            <GlobalSearchOverlay isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />
            {/* Search Bar */}
            <div className="flex items-center gap-3 flex-1 min-w-0 max-w-2xl">
                <button
                    type="button"
                    onClick={onMenuClick}
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
                {/* Notification bell — live work-queue summary (no read/unread). */}
                <div className="relative" ref={bellRef}>
                    <button
                        type="button"
                        onClick={() => setIsBellOpen((v) => !v)}
                        aria-label={wq.total > 0 ? `${wq.total} items need attention` : "Notifications"}
                        className="relative p-2 text-gray-500 hover:bg-gray-100 rounded-full transition-colors"
                    >
                        <Bell className="w-5 h-5" />
                        {wq.total > 0 && (
                            <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center bg-red-500 text-white text-[10px] font-bold rounded-full border-2 border-white tabular-nums">
                                {wq.total > 99 ? "99+" : wq.total}
                            </span>
                        )}
                    </button>

                    {isBellOpen && (
                        <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl shadow-lg border border-gray-100 py-2 animate-in fade-in slide-in-from-top-2 z-30 max-h-[80vh] overflow-y-auto">
                            <div className="px-4 py-2 border-b border-gray-50">
                                <p className="text-sm font-semibold text-gray-900">Notifications</p>
                            </div>

                            {visibleBellItems.length === 0 && wq.recent.length === 0 ? (
                                <div className="px-4 py-6 text-center">
                                    <p className="text-sm text-gray-500">You&apos;re all caught up 🎉</p>
                                </div>
                            ) : (
                                <>
                                    {/* Needs attention — open work, clears when done. */}
                                    {visibleBellItems.length > 0 && (
                                        <div className="py-1">
                                            <div className="flex items-center justify-between px-4 pt-1 pb-1">
                                                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Needs attention</p>
                                                <span className="text-[11px] text-gray-400 tabular-nums">{wq.attention_total} open</span>
                                            </div>
                                            {visibleBellItems.map((i) => {
                                                const Icon = i.icon;
                                                return (
                                                    <Link
                                                        key={i.key}
                                                        href={i.href}
                                                        onClick={() => setIsBellOpen(false)}
                                                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                                                    >
                                                        <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-gray-50 text-gray-500 shrink-0">
                                                            <Icon className="w-4 h-4" />
                                                        </span>
                                                        <span className="flex-1 min-w-0">{i.label}</span>
                                                        <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-[color:var(--color-brand-sky)] text-white text-[11px] font-bold tabular-nums">
                                                            {i.count > 99 ? "99+" : i.count}
                                                        </span>
                                                    </Link>
                                                );
                                            })}
                                        </div>
                                    )}

                                    {/* Recent activity — successes from the last 24h (auto-ages out). */}
                                    {wq.recent.length > 0 && (
                                        <div className="py-1 border-t border-gray-50">
                                            <p className="px-4 pt-1.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-gray-400">Recent activity</p>
                                            {wq.recent.map((e, idx) => {
                                                const isAgreement = e.type === "agreement";
                                                const Icon = isAgreement ? FileText : Video;
                                                const label = isAgreement ? "Agreement signed" : "Video KYC submitted";
                                                return (
                                                    <Link
                                                        key={`${e.type}-${e.lead_id}-${idx}`}
                                                        href={`/nbfc/acquire/${e.lead_id}`}
                                                        onClick={() => setIsBellOpen(false)}
                                                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                                                    >
                                                        <span className="relative flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 shrink-0">
                                                            <Icon className="w-4 h-4" />
                                                            <CheckCircle2 className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 text-emerald-500 bg-white rounded-full" />
                                                        </span>
                                                        <span className="flex-1 min-w-0">
                                                            <span className="block font-medium text-gray-800">{label}</span>
                                                            <span className="block text-xs text-gray-500 truncate">
                                                                {e.customer_name || e.lead_id}
                                                            </span>
                                                        </span>
                                                        <span className="text-[11px] text-gray-400 shrink-0">{relativeTime(e.at)}</span>
                                                    </Link>
                                                );
                                            })}
                                        </div>
                                    )}
                                </>
                            )}

                            <div className="border-t border-gray-100 mt-1 pt-1">
                                <Link
                                    href="/nbfc/acquire"
                                    onClick={() => setIsBellOpen(false)}
                                    className="block px-4 py-2 text-xs font-semibold text-[color:var(--color-brand-sky)] hover:bg-gray-50 transition-colors"
                                >
                                    Go to Acquire →
                                </Link>
                            </div>
                        </div>
                    )}
                </div>

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
                            <p className="text-sm font-semibold text-gray-900 leading-none">{tenantName}</p>
                            <span
                                className="inline-block mt-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-[0.14em] uppercase"
                                style={{
                                    background: "var(--brand-sky-soft)",
                                    color: "var(--color-brand-sky)",
                                }}
                            >
                                NBFC Partner
                            </span>
                        </div>
                        <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${isProfileOpen ? "rotate-180" : ""}`} />
                    </button>

                    {/* Dropdown Menu */}
                    {isProfileOpen && (
                        <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-lg border border-gray-100 py-2 animate-in fade-in slide-in-from-top-2">
                            <div className="px-4 py-2 border-b border-gray-50 md:hidden">
                                <p className="text-sm font-medium text-gray-900">{tenantName}</p>
                                <p className="text-xs text-gray-500">{displayEmail}</p>
                            </div>

                            <div className="py-1">
                                <Link href="/profile" className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-brand-600 transition-colors">
                                    <User className="w-4 h-4" />
                                    View Profile
                                </Link>
                                <button className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-brand-600 transition-colors">
                                    <Settings className="w-4 h-4" />
                                    Change Password
                                </button>
                                <button className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-brand-600 transition-colors">
                                    <CreditCard className="w-4 h-4" />
                                    Subscription: <span className="text-green-600 font-medium text-xs bg-green-50 px-1.5 py-0.5 rounded-full">Active</span>
                                </button>
                            </div>

                            <div className="border-t border-gray-100 my-1"></div>

                            <button
                                onClick={handleLogout}
                                disabled={loggingOut}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <LogOut className="w-4 h-4" />
                                {loggingOut ? "Signing out…" : "Logout"}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </header>
    );
}
