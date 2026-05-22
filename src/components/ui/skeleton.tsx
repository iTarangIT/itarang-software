// shadcn-style Skeleton — soft shimmer placeholder on the brand border tint.

import { cn } from "@/lib/utils";

export function Skeleton({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn("animate-pulse rounded-md bg-border/70", className)}
            {...props}
        />
    );
}
