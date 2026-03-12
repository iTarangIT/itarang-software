import { db } from '@/lib/db';
import { orders, accounts } from '@/lib/db/schema';
import { eq, desc, avg } from 'drizzle-orm';
import { Clock, RefreshCcw, AlertTriangle } from 'lucide-react';

interface ReorderTrackingProps {
    accountId: string;
}

export default async function ReorderTracking({ accountId }: ReorderTrackingProps) {
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);

    if (!account) return null;

    // Fetch last 5 orders for TAT calculation
    const recentOrders = await db.select()
        .from(orders)
        .where(eq(orders.account_id, accountId))
        .orderBy(desc(orders.created_at))
        .limit(5);

    const tats = recentOrders.map(o => o.reorder_tat_days).filter(t => t !== null) as number[];
    const avgTat = tats.length > 0 ? (tats.reduce((a, b) => a + b, 0) / tats.length).toFixed(1) : 'N/A';

    return (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-6 flex items-center gap-2">
                <RefreshCcw className="w-4 h-4" />
                Reorder Insights (SOP 3.6)
            </h3>

            <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                    <p className="text-xs text-gray-500">Average TAT</p>
                    <p className="text-2xl font-black text-gray-900">{avgTat} <span className="text-xs font-normal">Days</span></p>
                </div>
                <div className="space-y-1">
                    <p className="text-xs text-gray-500">Last Order</p>
                    <p className="text-sm font-bold text-gray-800">
                        {account.last_order_fulfilled_at ? new Date(account.last_order_fulfilled_at).toLocaleDateString() : 'Never'}
                    </p>
                </div>
            </div>

            {tats[0] > 60 && (
                <div className="mt-4 p-3 bg-orange-50 rounded-lg flex gap-2 text-xs text-orange-800 border border-orange-100">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    Account is exceeding standard 60-day reorder cycle. Possible churn risk.
                </div>
            )}
        </div>
    );
}
