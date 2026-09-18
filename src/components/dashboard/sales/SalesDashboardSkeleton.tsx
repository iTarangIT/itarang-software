"use client";

// B7 — placeholder blocks in the shape of the real rows while the first fetch
// is in flight, so the page does not jump when the numbers land.

const block = "animate-pulse rounded-xl border border-border bg-bg/60";

export function SalesDashboardSkeleton({ withPerRep }: { withPerRep: boolean }) {
    return (
        <div className="space-y-4" aria-busy="true" aria-label="Loading sales dashboard">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
                {Array.from({ length: 7 }, (_, i) => (
                    <div key={i} className={`${block} h-24`} />
                ))}
            </div>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <div className={`${block} h-80 xl:col-span-2`} />
                <div className={`${block} h-80`} />
            </div>
            <div className={`${block} h-48`} />
            {withPerRep && <div className={`${block} h-64`} />}
        </div>
    );
}
