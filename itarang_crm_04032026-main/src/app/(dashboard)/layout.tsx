import React from "react";
import { LayoutWrapper } from "@/components/layout/LayoutWrapper";

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return <LayoutWrapper>{children}</LayoutWrapper>;
}
