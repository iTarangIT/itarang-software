"use client";

import React, { useState, useRef, useEffect } from 'react';
import { Search, Bell, LogOut, User, ChevronDown, Settings, CreditCard } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { GlobalSearchOverlay } from '@/components/search/GlobalSearchOverlay';
import { useAuth } from '@/components/auth/AuthProvider';
import { toast } from 'sonner';

export function Header() {
    const router = useRouter();
    const supabase = createClient();
    const { user } = useAuth();
    const [isProfileOpen, setIsProfileOpen] = useState(false);
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const displayName = user?.name || user?.email?.split('@')[0] || 'User';
    const displayEmail = user?.email || '';
    const displayRole = user?.role || 'user';
    const initials = displayName.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase();

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
        <header className="sticky top-0 z-20 bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between shadow-sm">
            <GlobalSearchOverlay isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />
            {/* Search Bar */}
            <div className="flex items-center gap-4 flex-1 max-w-2xl">
                <h2 className="text-xl font-bold text-brand-600 md:hidden">iTarang</h2>
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
                <button className="relative p-2 text-gray-500 hover:bg-gray-100 rounded-full transition-colors">
                    <Bell className="w-5 h-5" />
                    <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full border-2 border-white"></span>
                </button>

                {/* Profile Dropdown */}
                <div className="relative" ref={dropdownRef}>
                    <button
                        onClick={() => setIsProfileOpen(!isProfileOpen)}
                        className="flex items-center gap-2 hover:bg-gray-50 p-1.5 rounded-lg transition-colors focus:outline-none"
                    >
                        <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 font-bold border border-brand-200">
                            {initials}
                        </div>
                        <div className="hidden md:block text-left">
                            <p className="text-sm font-medium text-gray-700 leading-none">{displayName}</p>
                            <p className="text-xs text-gray-500 capitalize">{displayRole}</p>
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
                                {loggingOut ? 'Signing out…' : 'Logout'}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </header>
    );
}