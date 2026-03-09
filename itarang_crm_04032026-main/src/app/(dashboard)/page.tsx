"use client";

import React from 'react';
import { useAuth } from '@/components/auth/AuthProvider';
import { LayoutDashboard, Rocket, ShieldCheck, Zap } from 'lucide-react';
import ApprovalWidget from '@/components/dashboard/ApprovalWidget';

export default function DashboardRootPage() {
    const { user, loading } = useAuth();

    if (loading) {
        return (
            <div className="h-[60vh] flex items-center justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600"></div>
            </div>
        );
    }

    return (
        <div className="max-w-4xl mx-auto py-12">
            <div className="text-center mb-12">
                <div className="inline-flex p-3 bg-brand-50 rounded-2xl mb-4">
                    <Rocket className="w-8 h-8 text-brand-600" />
                </div>
                <h1 className="text-4xl font-extrabold text-gray-900 tracking-tight mb-4">
                    Welcome to iTarang, {user?.name || 'User'}!
                </h1>
                <p className="text-lg text-gray-600 max-w-2xl mx-auto">
                    You've successfully logged into the iTarang CRM. Use the sidebar to navigate through your assigned modules and tools.
                </p>
            </div>

            <div className="mb-12">
                <ApprovalWidget />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                <div className="p-6 bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
                    <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center mb-4">
                        <LayoutDashboard className="w-5 h-5 text-blue-600" />
                    </div>
                    <h3 className="text-lg font-bold text-gray-900 mb-2">Centralized View</h3>
                    <p className="text-sm text-gray-500">Access all your key performance indicators and metrics in one place.</p>
                </div>

                <div className="p-6 bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
                    <div className="w-10 h-10 bg-green-50 rounded-xl flex items-center justify-center mb-4">
                        <ShieldCheck className="w-5 h-5 text-green-600" />
                    </div>
                    <h3 className="text-lg font-bold text-gray-900 mb-2">Secure Access</h3>
                    <p className="text-sm text-gray-500">Your data is protected with enterprise-grade security and role-based controls.</p>
                </div>

                <div className="p-6 bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
                    <div className="w-10 h-10 bg-purple-50 rounded-xl flex items-center justify-center mb-4">
                        <Zap className="w-5 h-5 text-purple-600" />
                    </div>
                    <h3 className="text-lg font-bold text-gray-900 mb-2">Real-time Sync</h3>
                    <p className="text-sm text-gray-500">Stay updated with live notifications and real-time data synchronization.</p>
                </div>
            </div>

            <div className="mt-16 p-8 bg-gray-50 rounded-3xl border border-gray-200 text-center">
                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-widest mb-4">Your Active Role</h3>
                <span className="inline-flex items-center px-4 py-1.5 rounded-full text-sm font-bold bg-brand-600 text-white shadow-lg shadow-brand-500/20 uppercase">
                    {user?.role || 'user'}
                </span>
                <p className="mt-4 text-xs text-gray-400">
                    If you believe your role permissions are incorrect, please contact your system administrator.
                </p>
            </div>
        </div>
    );
}
