'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2, Database, RefreshCw } from 'lucide-react';

export function DatabaseHealth() {
    const { data, isLoading, refetch, isFetching } = useQuery({
        queryKey: ['intellicar-database-stats'],
        queryFn: async () => {
            const res = await fetch('/api/system/database-monitor');
            if (!res.ok) throw new Error('Failed');
            return (await res.json()).data;
        },
        refetchInterval: 60000,
    });

    if (isLoading) {
        return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 text-brand-600 animate-spin" /></div>;
    }

    const tables = Array.isArray(data) ? data : [];

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Database className="w-5 h-5 text-brand-600" />
                    <h3 className="text-sm font-semibold text-gray-900">Database Health Monitor</h3>
                </div>
                <button
                    onClick={() => refetch()}
                    disabled={isFetching}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200"
                >
                    <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} />
                    Refresh
                </button>
            </div>

            <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                                <th className="px-4 py-3 font-medium">Schema</th>
                                <th className="px-4 py-3 font-medium">Table</th>
                                <th className="px-4 py-3 font-medium text-right">Row Count</th>
                                <th className="px-4 py-3 font-medium text-right">Size</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tables.length === 0 ? (
                                <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No table data available</td></tr>
                            ) : tables.map((t: Record<string, unknown>, i: number) => (
                                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                                    <td className="px-4 py-3">
                                        <span className="inline-block px-2 py-0.5 text-xs font-medium bg-blue-50 text-blue-700 rounded">
                                            {String(t.schema || 'public')}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 font-medium text-gray-900">{String(t.table_name || '-')}</td>
                                    <td className="px-4 py-3 text-right font-mono text-gray-600">{Number(t.row_count || 0).toLocaleString()}</td>
                                    <td className="px-4 py-3 text-right text-gray-500">{String(t.total_size || '-')}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
