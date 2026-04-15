"use client";

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
    LayoutDashboard,
    ShoppingCart,
    Users,
    FileText,
    Phone,
    PieChart,
    Package,
    FileCheck,
    Landmark,
    Briefcase,
    Building,
    Receipt,
    ClipboardCheck,
    Car,
    Battery,
    Wrench,
    CreditCard,
    Megaphone,
    Shield,
    Search,
    type LucideIcon
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/components/auth/AuthProvider';
import { formatRoleLabel, resolveRole } from '@/lib/roles';

type NavigationItem = {
    id: string;
    label: string;
    icon: LucideIcon;
    href: string;
};

type NavigationGroup = {
    section: string;
    items: NavigationItem[];
};

const roleNavigation: Record<string, NavigationGroup[]> = {
    ceo: [
        { section: 'OVERVIEW', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, href: '/ceo' }] },
        {
            section: 'BUSINESS', items: [
                { id: 'product-catalog', label: 'Product Catalog', icon: Package, href: '/product-catalog' },
                { id: 'oems', label: 'OEMs', icon: Landmark, href: '/oem-onboarding' },
                { id: 'inventory-reports', label: 'Inventory', icon: PieChart, href: '/inventory' },
                { id: 'leads', label: 'Leads', icon: Users, href: '/leads' },
                { id: 'deals', label: 'Deals', icon: FileCheck, href: '/deals' },
            ]
        },
        {
            section: 'INTELLIGENCE', items: [
                { id: 'intellicar', label: 'Intellicar Dashboard', icon: Battery, href: '/ceo/intellicar' },
                { id: 'ai-dialer', label: 'AI Dialer (Bolna)', icon: Phone, href: '/ceo/ai-dialer' },
            ]
        },
        {
            section: 'ADMIN', items: [
                { id: 'kyc-review', label: 'KYC Review', icon: Shield, href: '/admin/kyc-review' },
                { id: 'dealer-validation', label: 'Dealer Validation', icon: ClipboardCheck, href: '/admin/dealer-verification' },
            ]
        },
    ],

    sales_head: [
        { section: 'OVERVIEW', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, href: '/sales-head' }] },
        {
            section: 'SALES', items: [
                { id: 'leads', label: 'Leads', icon: Users, href: '/leads' },
                { id: 'deals', label: 'Deals', icon: FileCheck, href: '/deals' },
                { id: 'approvals', label: 'Approvals', icon: FileText, href: '/sales-head/approvals' },
            ]
        },
        {
            section: 'DEALER PROSPECTING', items: [
                { id: 'dealer-scraper', label: 'Dealer Scraper', icon: Search, href: '/sales-head/scraper' },
                { id: 'ai-dialer', label: 'AI Dialer (Bolna)', icon: Phone, href: '/ceo/ai-dialer' },
            ]
        },
        {
            section: 'ADMIN', items: [
                { id: 'kyc-review', label: 'KYC Review', icon: Shield, href: '/admin/kyc-review' },
                { id: 'dealer-validation', label: 'Dealer Validation', icon: ClipboardCheck, href: '/admin/dealer-verification' },
            ]
        },
    ],

    sales_manager: [
        { section: 'OVERVIEW', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, href: '/sales-manager' }] },
        {
            section: 'SALES', items: [
                { id: 'leads', label: 'My Leads', icon: Users, href: '/leads' },
                { id: 'deals', label: 'My Deals', icon: FileCheck, href: '/deals' },
                { id: 'ai-calls', label: 'AI Calls', icon: Phone, href: '/sales-manager/ai-calls' },
            ]
        },
        {
            section: 'DEALER PROSPECTING', items: [
                { id: 'scraper-leads', label: 'Scraped Leads', icon: Search, href: '/sales-manager/scraper-leads' },
            ]
        },
    ],

    inventory_manager: [
        { section: 'OVERVIEW', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, href: '/inventory-manager' }] },
        {
            section: 'INVENTORY', items: [
                { id: 'product-catalog', label: 'Product Catalog', icon: Package, href: '/product-catalog' },
                { id: 'inventory-reports', label: 'Inventory', icon: PieChart, href: '/inventory' },
                { id: 'bulk-upload', label: 'Bulk Upload', icon: ShoppingCart, href: '/inventory/bulk-upload' },
            ]
        },
    ],

    service_engineer: [
        { section: 'OVERVIEW', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, href: '/service-engineer' }] },
        {
            section: 'PDI', items: [
                { id: 'pdi-queue', label: 'PDI Queue', icon: FileCheck, href: '/service-engineer/pdi-queue' },
            ]
        },
    ],

    business_head: [
        { section: 'OVERVIEW', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, href: '/business-head' }] },
        {
            section: 'MANAGEMENT', items: [
                { id: 'approvals', label: 'Approvals', icon: FileCheck, href: '/business-head/approvals' },
                { id: 'credits', label: 'Credit Management', icon: Landmark, href: '/business-head/credits' },
            ]
        },
        {
            section: 'ADMIN', items: [
                { id: 'kyc-review', label: 'KYC Review', icon: Shield, href: '/admin/kyc-review' },
                { id: 'dealer-validation', label: 'Dealer Validation', icon: ClipboardCheck, href: '/admin/dealer-verification' },
            ]
        },
    ],

    finance_controller: [
        { section: 'OVERVIEW', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, href: '/finance-controller' }] },
        {
            section: 'FINANCE', items: [
                { id: 'invoices', label: 'Invoices', icon: FileText, href: '/finance-controller/invoices' },
                { id: 'payments', label: 'Payments', icon: Landmark, href: '/finance-controller/payments' },
                { id: 'credits', label: 'Credits', icon: Briefcase, href: '/finance-controller/credits' },
            ]
        },
    ],

    sales_order_manager: [
        { section: 'OVERVIEW', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, href: '/sales-order-manager' }] },
        {
            section: 'OPERATIONS', items: [
                { id: 'oem-onboarding', label: 'OEM Onboarding', icon: Building, href: '/sales-order-manager/oem-onboarding' },
                { id: 'provisions', label: 'Provisions', icon: FileText, href: '/sales-order-manager/provisions' },
                { id: 'orders', label: 'Orders', icon: ShoppingCart, href: '/sales-order-manager/orders' },
                { id: 'pi-invoices', label: 'PI & Invoices', icon: Receipt, href: '/sales-order-manager/pi-invoices' },
            ]
        },
    ],

    sales_executive: [
        { section: 'OVERVIEW', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, href: '/sales-executive' }] },
        {
            section: 'SALES', items: [
                { id: 'leads', label: 'My Leads', icon: Users, href: '/leads' },
                { id: 'deals', label: 'My Deals', icon: FileCheck, href: '/deals' },
            ]
        },
    ],

    dealer: [
        {
            section: 'OVERVIEW',
            items: [
                { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, href: '/dealer-portal' },
            ]
        },
        {
            section: 'SALES',
            items: [
                { id: 'leads', label: 'Lead Management', icon: Users, href: '/dealer-portal/leads' },
                { id: 'loans', label: 'Loan Processing', icon: Landmark, href: '/dealer-portal/loans' },
                { id: 'loan-mgmt', label: 'Loan Management', icon: CreditCard, href: '/dealer-portal/loans/management' },
                { id: 'assets', label: 'Asset Management', icon: Car, href: '/dealer-portal/assets' },
                { id: 'batteries', label: 'Battery Management', icon: Battery, href: '/dealer-portal/batteries' },
            ]
        },
        {
            section: 'OPERATIONS',
            items: [
                { id: 'orders', label: 'Orders from OEM', icon: ShoppingCart, href: '/dealer-portal/orders' },
                { id: 'inventory', label: 'Inventory', icon: Package, href: '/dealer-portal/inventory' },
                { id: 'service', label: 'Service Management', icon: Wrench, href: '/dealer-portal/service' },
                { id: 'campaigns', label: 'Campaigns', icon: Megaphone, href: '/dealer-portal/campaigns/new' },
            ]
        }
    ],

    user: [
        { section: 'OVERVIEW', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, href: '/' }] }
    ]
};

export function Sidebar() {
    const pathname = usePathname();
    const { user, loading } = useAuth();

    if (loading || !user) {
        return <div className="w-64 bg-slate-50/50 h-full border-r border-gray-100 hidden md:flex animate-pulse" />;
    }

    const userRole = resolveRole(user.role, pathname);
    const menuItems = roleNavigation[userRole] || roleNavigation['user'] || [];
    const displayRole = formatRoleLabel(user.role, pathname);

    return (
        <div className="w-64 bg-slate-50/50 h-full border-r border-gray-100 flex flex-col fixed left-0 top-0 z-10 hidden md:flex">
            <div className="p-6 flex items-center gap-3">
                <div className="w-8 h-8 bg-brand-600 rounded-xl shadow-lg shadow-brand-500/20 flex items-center justify-center">
                    <div className="w-4 h-4 bg-white rounded-sm opacity-50 rotate-45"></div>
                </div>
                <span className="text-xl font-bold text-gray-800 tracking-tight">iTarang</span>
            </div>

            <div className="flex-1 overflow-y-auto py-4 px-4 space-y-8">
                {menuItems.map((group) => (
                    <div key={group.section}>
                        <h3 className="text-xs font-semibold text-gray-400 mb-3 px-2 tracking-wider">{group.section}</h3>
                        <div className="space-y-1">
                            {group.items.map((item) => {
                                const isActive = pathname === item.href;
                                return (
                                    <Link
                                        key={item.id}
                                        href={item.href}
                                        className={cn(
                                            "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 relative group",
                                            isActive
                                                ? "bg-brand-50 text-brand-700 shadow-sm"
                                                : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
                                        )}
                                    >
                                        {isActive && (
                                            <div className="absolute left-0 top-1.5 bottom-1.5 w-[3px] bg-brand-600 rounded-r-full" />
                                        )}
                                        <item.icon className={cn("w-5 h-5", isActive ? "text-brand-600" : "text-gray-400 group-hover:text-gray-600")} />
                                        {item.label}
                                    </Link>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>

            <div className="p-4 border-t border-gray-100/50 space-y-2">
                <div className="flex items-center gap-3 p-3 rounded-xl hover:bg-white hover:shadow-sm transition-all group cursor-default">
                    <div className="w-9 h-9 bg-brand-600 rounded-full flex items-center justify-center text-white font-semibold text-sm shadow-sm uppercase">
                        {user.name?.[0] || user.email?.[0] || 'U'}
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-gray-900 truncate">{user.name || 'User'}</p>
                        <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium mt-1 bg-brand-100 text-brand-700 uppercase">
                            {displayRole}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
