'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
    Loader2, Search, Wrench, AlertCircle, Plus,
    CheckCircle2, Clock, XCircle, ChevronRight, User
} from 'lucide-react';
import { useAuth } from '@/components/auth/AuthProvider';

type ServiceTicket = {
    id: string;
    customer_name: string;
    customer_phone: string;
    deployed_asset_id: string;
    serial_number?: string;
    issue_type: string;
    issue_description: string;
    priority: string;
    status: string;
    assigned_to_name?: string;
    resolution_type?: string;
    resolution_notes?: string;
    sla_deadline: string | null;
    sla_breached: boolean;
    created_at: string;
};

export default function ServiceManagementPage() {
    const router = useRouter();
    const { user } = useAuth();
    const [tickets, setTickets] = useState<ServiceTicket[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterStatus, setFilterStatus] = useState('all');
    const [filterPriority, setFilterPriority] = useState('all');
    const [showNewTicket, setShowNewTicket] = useState(false);

    // New ticket form
    const [newTicket, setNewTicket] = useState({
        customer_name: '', customer_phone: '', deployed_asset_id: '',
        issue_type: '', issue_description: '', priority: 'medium',
    });
    const [creating, setCreating] = useState(false);

    useEffect(() => {
        const fetchTickets = async () => {
            try {
                const params = new URLSearchParams({ status: filterStatus, priority: filterPriority, search: searchQuery });
                const res = await fetch(`/api/dealer/service-tickets?${params}`);
                const data = await res.json();
                if (data.success) setTickets(data.data);
            } catch { /* silent */ }
            finally { setLoading(false); }
        };
        fetchTickets();
    }, [filterStatus, filterPriority, searchQuery]);

    const handleCreateTicket = async () => {
        setCreating(true);
        try {
            const res = await fetch('/api/dealer/service-tickets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newTicket),
            });
            const data = await res.json();
            if (data.success) {
                setShowNewTicket(false);
                setNewTicket({ customer_name: '', customer_phone: '', deployed_asset_id: '', issue_type: '', issue_description: '', priority: 'medium' });
                // Refresh
                const refreshRes = await fetch(`/api/dealer/service-tickets?status=${filterStatus}&priority=${filterPriority}&search=${searchQuery}`);
                const refreshData = await refreshRes.json();
                if (refreshData.success) setTickets(refreshData.data);
            }
        } catch { /* silent */ }
        finally { setCreating(false); }
    };

    const openTickets = tickets.filter(t => ['open', 'assigned', 'in_progress'].includes(t.status));
    const breachedTickets = tickets.filter(t => t.sla_breached);

    const priorityColor = (p: string) => ({ critical: 'bg-red-50 text-red-700', high: 'bg-orange-50 text-orange-700', medium: 'bg-yellow-50 text-yellow-700', low: 'bg-gray-100 text-gray-600' }[p] || 'bg-gray-100 text-gray-600');
    const statusColor = (s: string) => ({ open: 'bg-blue-50 text-blue-700', assigned: 'bg-purple-50 text-purple-700', in_progress: 'bg-amber-50 text-amber-700', resolved: 'bg-green-50 text-green-700', closed: 'bg-gray-100 text-gray-500', escalated: 'bg-red-50 text-red-700' }[s] || 'bg-gray-100 text-gray-600');

    return (
        <div className="min-h-screen bg-[#F8F9FB]">
            <div className="max-w-[1400px] mx-auto px-6 py-8">
                <header className="mb-8 flex justify-between items-start">
                    <div>
                        <h1 className="text-[28px] font-black text-gray-900 tracking-tight">Service Management</h1>
                        <p className="text-sm text-gray-500 mt-1">Track service tickets, repairs, and warranty claims</p>
                    </div>
                    <button onClick={() => setShowNewTicket(true)} className="px-6 py-3 bg-[#0047AB] text-white rounded-xl text-sm font-bold hover:bg-[#003580] flex items-center gap-2">
                        <Plus className="w-4 h-4" /> New Service Ticket
                    </button>
                </header>

                {/* KPI Cards */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                    <KPICard icon={<Wrench className="w-5 h-5" />} label="Total Tickets" value={tickets.length.toString()} color="blue" />
                    <KPICard icon={<Clock className="w-5 h-5" />} label="Open" value={openTickets.length.toString()} color="amber" />
                    <KPICard icon={<CheckCircle2 className="w-5 h-5" />} label="Resolved" value={tickets.filter(t => t.status === 'resolved').length.toString()} color="green" />
                    <KPICard icon={<AlertCircle className="w-5 h-5" />} label="SLA Breached" value={breachedTickets.length.toString()} color="red" />
                </div>

                {/* Filters */}
                <div className="flex items-center gap-3 mb-6">
                    {['all', 'open', 'assigned', 'in_progress', 'resolved', 'closed', 'escalated'].map(s => (
                        <button key={s} onClick={() => setFilterStatus(s)} className={`px-3 py-1.5 rounded-lg text-xs font-bold capitalize ${filterStatus === s ? 'bg-[#0047AB] text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>
                            {s.replace(/_/g, ' ')}
                        </button>
                    ))}
                    <div className="flex-1" />
                    <select value={filterPriority} onChange={e => setFilterPriority(e.target.value)} className="px-3 py-1.5 border border-gray-200 rounded-lg text-xs font-bold bg-white">
                        <option value="all">All Priority</option>
                        <option value="critical">Critical</option>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                    </select>
                    <div className="relative">
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search..." className="pl-10 pr-4 py-2 border border-gray-200 rounded-xl text-sm w-48 outline-none focus:border-[#1D4ED8]" />
                    </div>
                </div>

                {/* Table */}
                <div className="bg-white rounded-[20px] border border-gray-100 shadow-sm overflow-hidden">
                    {loading ? (
                        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-[#1D4ED8]" /></div>
                    ) : tickets.length === 0 ? (
                        <div className="text-center py-20 text-gray-400">
                            <Wrench className="w-12 h-12 mx-auto mb-3 opacity-30" />
                            <p className="font-bold">No service tickets</p>
                        </div>
                    ) : (
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-gray-100 bg-gray-50/50">
                                    <th className="text-left py-4 px-6 font-bold text-gray-500 text-xs uppercase">Ticket ID</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Customer</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Issue</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Priority</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Assigned To</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Status</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">SLA</th>
                                    <th className="text-left py-4 px-4 font-bold text-gray-500 text-xs uppercase">Created</th>
                                </tr>
                            </thead>
                            <tbody>
                                {tickets.map(t => (
                                    <tr key={t.id} className="border-b border-gray-50 hover:bg-gray-50/50 cursor-pointer">
                                        <td className="py-4 px-6 font-bold text-[#0047AB]">{t.id}</td>
                                        <td className="py-4 px-4">
                                            <div className="font-medium">{t.customer_name}</div>
                                            <div className="text-xs text-gray-400">{t.customer_phone}</div>
                                        </td>
                                        <td className="py-4 px-4">
                                            <div className="font-medium capitalize">{t.issue_type.replace(/_/g, ' ')}</div>
                                            <div className="text-xs text-gray-400 truncate max-w-[200px]">{t.issue_description}</div>
                                        </td>
                                        <td className="py-4 px-4">
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold capitalize ${priorityColor(t.priority)}`}>{t.priority}</span>
                                        </td>
                                        <td className="py-4 px-4 text-xs">{t.assigned_to_name || <span className="text-gray-300">Unassigned</span>}</td>
                                        <td className="py-4 px-4">
                                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold capitalize ${statusColor(t.status)}`}>{t.status.replace(/_/g, ' ')}</span>
                                        </td>
                                        <td className="py-4 px-4">
                                            {t.sla_breached ? <span className="text-red-600 text-xs font-bold">Breached</span> : t.sla_deadline ? <span className="text-xs text-gray-400">{new Date(t.sla_deadline).toLocaleDateString()}</span> : '-'}
                                        </td>
                                        <td className="py-4 px-4 text-xs text-gray-500">{new Date(t.created_at).toLocaleDateString()}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                {/* New Ticket Modal */}
                {showNewTicket && (
                    <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
                        <div className="bg-white rounded-3xl w-full max-w-lg p-8 shadow-2xl">
                            <h2 className="text-xl font-bold text-gray-900 mb-6">New Service Ticket</h2>
                            <div className="space-y-4">
                                <input value={newTicket.customer_name} onChange={e => setNewTicket(p => ({ ...p, customer_name: e.target.value }))} placeholder="Customer Name *" className="w-full h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />
                                <input value={newTicket.customer_phone} onChange={e => setNewTicket(p => ({ ...p, customer_phone: e.target.value }))} placeholder="Customer Phone *" className="w-full h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />
                                <input value={newTicket.deployed_asset_id} onChange={e => setNewTicket(p => ({ ...p, deployed_asset_id: e.target.value }))} placeholder="Asset ID (optional)" className="w-full h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />
                                <select value={newTicket.issue_type} onChange={e => setNewTicket(p => ({ ...p, issue_type: e.target.value }))} className="w-full h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]">
                                    <option value="">Select Issue Type *</option>
                                    <option value="battery_failure">Battery Failure</option>
                                    <option value="charger_issue">Charger Issue</option>
                                    <option value="physical_damage">Physical Damage</option>
                                    <option value="performance_degradation">Performance Degradation</option>
                                    <option value="connectivity">Connectivity Issue</option>
                                    <option value="other">Other</option>
                                </select>
                                <textarea value={newTicket.issue_description} onChange={e => setNewTicket(p => ({ ...p, issue_description: e.target.value }))} placeholder="Describe the issue *" className="w-full min-h-[80px] px-4 py-3 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]" />
                                <select value={newTicket.priority} onChange={e => setNewTicket(p => ({ ...p, priority: e.target.value }))} className="w-full h-11 px-4 border-2 border-[#EBEBEB] rounded-xl text-sm outline-none focus:border-[#1D4ED8]">
                                    <option value="low">Low Priority</option>
                                    <option value="medium">Medium Priority</option>
                                    <option value="high">High Priority</option>
                                    <option value="critical">Critical</option>
                                </select>
                            </div>
                            <div className="flex gap-4 mt-8">
                                <button onClick={() => setShowNewTicket(false)} className="flex-1 py-3 border-2 border-gray-200 rounded-xl font-bold text-gray-600">Cancel</button>
                                <button onClick={handleCreateTicket} disabled={creating || !newTicket.issue_type || !newTicket.issue_description || !newTicket.customer_name} className="flex-[2] py-3 bg-[#0047AB] text-white rounded-xl font-bold disabled:opacity-40 flex items-center justify-center gap-2">
                                    {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Create Ticket
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function KPICard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
    const colorClasses: Record<string, string> = { blue: 'bg-blue-50 text-blue-600', green: 'bg-green-50 text-green-600', amber: 'bg-amber-50 text-amber-600', red: 'bg-red-50 text-red-600' };
    return (
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${colorClasses[color]}`}>{icon}</div>
            <p className="text-2xl font-black text-gray-900">{value}</p>
            <p className="text-xs font-medium text-gray-400 mt-1">{label}</p>
        </div>
    );
}
