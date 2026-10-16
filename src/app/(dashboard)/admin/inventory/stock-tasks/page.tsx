// Tracker ID 174 — "Stock to upload" tasks: one per new battery invoice. Each
// serial on the invoice is shown as in the buyer dealer's stock, missing, or
// in stock under another dealer. A task closes by itself when every serial is
// in the buyer's stock (checked on every upload and hourly); open after 2
// working days it is escalated to Admin and the CEO. Upload the stock the
// usual way (Bulk Upload); "Close by hand" is for an invoice that will never
// be stocked (cancelled, not a dealer sale).

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { requireAuth } from "@/lib/auth-utils";
import { listStockTasks, STOCK_TASK_ROLES, type StockTask } from "@/lib/inventory/stockUploadTasks/service";
import { CloseStockTaskButton } from "./CloseStockTaskButton";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
    in_stock: "In stock",
    missing: "Missing",
    other_dealer: "Under another dealer",
};
const STATUS_TONE: Record<string, string> = {
    in_stock: "bg-emerald-50 text-emerald-700 border-emerald-200",
    missing: "bg-red-50 text-red-700 border-red-200",
    other_dealer: "bg-amber-50 text-amber-800 border-amber-200",
};

const day = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "—";

function TaskCard({ t, canClose }: { t: StockTask; canClose: boolean }) {
    const tone =
        t.status === "closed" ? "border-gray-200" : t.overdue ? "border-red-300" : "border-amber-200";
    return (
        <section id={`task-${t.id}`} className={`rounded-xl border ${tone} bg-white p-4 space-y-3 scroll-mt-24`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <h2 className="font-semibold text-gray-900">
                        Invoice {t.invoiceNumber ?? "(no number)"} · {t.accountName ?? t.customerName ?? "Buyer not matched"}
                    </h2>
                    <p className="text-xs text-gray-500">
                        Dated {day(t.invoiceDate)} · Bill To GSTIN {t.customerGstin ?? "—"}
                        {t.accountId ? ` · dealer account ${t.accountId}` : " · buyer not linked to a dealer account: link the invoice in Invoice Ledger"}
                    </p>
                </div>
                <div className="text-right text-xs">
                    {t.status === "closed" ? (
                        <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 font-semibold text-gray-700">
                            Closed {day(t.closedAt)} · {t.closedHow === "by_hand" ? "by hand" : t.closedHow === "voided" ? "invoice voided / credit-noted" : "all serials in stock"}
                        </span>
                    ) : (
                        <span
                            className={`rounded-full border px-2 py-0.5 font-semibold ${t.overdue ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}
                        >
                            {t.overdue ? "Overdue" : "Open"} · due {day(t.dueAt)}
                        </span>
                    )}
                </div>
            </div>
            <p className="text-sm text-gray-700">{t.progress}</p>
            {t.serials.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                    {t.serials.map((s) => (
                        <li
                            key={s.serial}
                            className={`rounded-md border px-2 py-0.5 font-mono text-xs ${STATUS_TONE[s.status]}`}
                            title={s.status === "other_dealer" && s.dealerName ? `In stock under ${s.dealerName}` : STATUS_LABEL[s.status]}
                        >
                            {s.serial} · {STATUS_LABEL[s.status]}
                            {s.status === "other_dealer" && s.dealerName ? ` (${s.dealerName})` : ""}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-xs text-gray-500">No serial numbers were read from this invoice.</p>
            )}
            {t.closeNote && <p className="text-xs text-gray-500">Note: {t.closeNote}</p>}
            {canClose && t.status !== "closed" && <CloseStockTaskButton taskId={t.id} />}
        </section>
    );
}

export default async function StockTasksPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
    const user = await requireAuth();
    const allowed = STOCK_TASK_ROLES.includes(user.role);
    const { show } = await searchParams;
    const filter = show === "closed" ? "closed" : show === "all" ? "all" : "open";
    const tasks = allowed ? await listStockTasks(filter) : null;

    return (
        <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
            <div>
                <Link href="/admin/inventory" className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline">
                    <ArrowLeft className="h-3.5 w-3.5" /> Inventory
                </Link>
                <h1 className="mt-2 text-2xl font-bold text-gray-900">Stock to upload</h1>
                <p className="mt-1 max-w-3xl text-sm text-gray-600">
                    One task per new battery invoice. Every serial on the invoice must be in the stock of the dealer it was
                    billed to. Upload the stock with{" "}
                    <Link href="/admin/inventory/upload" className="text-blue-700 hover:underline">
                        Bulk Upload
                    </Link>
                    ; the task closes by itself when all serials are in, and goes to Admin and the CEO after 2 working days.
                </p>
            </div>

            {!allowed ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                    Only Admin, the Inventory Manager, the partner login and the CEO see stock-upload tasks.
                </p>
            ) : tasks == null ? (
                <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
                    Stock-upload tasks are not set up on this database yet (migration E-348).
                </p>
            ) : (
                <>
                    <nav className="flex gap-3 text-sm">
                        {(["open", "closed", "all"] as const).map((f) => (
                            <Link
                                key={f}
                                href={f === "open" ? "/admin/inventory/stock-tasks" : `/admin/inventory/stock-tasks?show=${f}`}
                                className={f === filter ? "font-semibold text-gray-900 underline" : "text-blue-700 hover:underline"}
                            >
                                {f === "open" ? "Open" : f === "closed" ? "Closed" : "All"}
                            </Link>
                        ))}
                        <span className="ml-auto text-xs text-gray-500">{tasks.length} task{tasks.length === 1 ? "" : "s"}</span>
                    </nav>
                    {tasks.length === 0 ? (
                        <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">Nothing here right now.</p>
                    ) : (
                        tasks.map((t) => <TaskCard key={t.id} t={t} canClose={user.role !== "ceo"} />)
                    )}
                </>
            )}
        </div>
    );
}
