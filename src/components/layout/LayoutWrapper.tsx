"use client";

import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { AuthProvider } from "@/components/auth/AuthProvider";

type InitialUser = {
    id: string;
    email: string;
    role: string;
    name?: string | null;
    dealer_id?: string | null;
    phone?: string | null;
    avatar_url?: string | null;
    onboarding_status?: string | null;
    review_status?: string | null;
    dealer_account_status?: string | null;
};

export function LayoutWrapper({
    children,
    initialUser,
}: {
    children: React.ReactNode;
    initialUser?: InitialUser | null;
}) {
    return (
        <AuthProvider initialUser={initialUser}>
            <div className="flex">
                <Sidebar />
                <div className="flex-1 md:ml-64 flex flex-col min-h-screen">
                    <Header />
                    <main className="flex-1 p-6 md:p-8 overflow-y-auto">
                        <div className="max-w-7xl mx-auto">{children}</div>
                    </main>
                </div>
            </div>
        </AuthProvider>
    );
}