import React, { useState, useEffect } from 'react';
import { Plus, Download, MoreHorizontal, Search, Calendar, X, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Provision } from '../types';
import { useToast } from './Toast';

export const Provisions: React.FC = () => {
    const { showToast } = useToast();
    const [provisions, setProvisions] = useState<Provision[]>([]);
    const [loading, setLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [formData, setFormData] = useState({
        oem_name: '',
        product_model: '',
        quantity: '',
        unit_price: ''
    });

    useEffect(() => {
        fetchProvisions();
    }, []);

    const fetchProvisions = async () => {
        try {
            setLoading(true);
            const { data, error } = await supabase
                .from('provisions')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            setProvisions(data || []);
        } catch (error) {
            console.error('Error fetching provisions:', error);
            showToast('Failed to fetch provisions', 'error');
        } finally {
            setLoading(false);
        }
    };

    const filtered = provisions.filter(p =>
        p.product_model.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.oem_name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const getStatusStyle = (status: string) => {
        switch (status) {
            case 'Completed': return 'bg-green-100 text-green-700';
            case 'Ordered': return 'bg-blue-100 text-blue-700';
            case 'Pending': return 'bg-yellow-100 text-yellow-700';
            case 'Cancelled': return 'bg-red-100 text-red-700';
            default: return 'bg-gray-100 text-gray-700';
        }
    };

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            setIsCreating(true);
            const newProvision = {
                id: `PROV-${new Date().toISOString().split('T')[0].replace(/-/g, '')}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`,
                oem_name: formData.oem_name,
                product_model: formData.product_model,
                quantity: parseInt(formData.quantity),
                unit_price: parseInt(formData.unit_price),
                total_value: parseInt(formData.quantity) * parseInt(formData.unit_price),
                status: 'Pending',
                created_at: new Date().toISOString().split('T')[0]
            };

            const { data, error } = await supabase
                .from('provisions')
                .insert([newProvision])
                .select();

            if (error) throw error;

            if (data) {
                setProvisions([data[0], ...provisions]);
                showToast('Provision created successfully', 'success');
            }

            setIsModalOpen(false);
            setFormData({ oem_name: '', product_model: '', quantity: '', unit_price: '' });
        } catch (error) {
            console.error('Error creating provision:', error);
            showToast('Failed to create provision', 'error');
        } finally {
            setIsCreating(false);
        }
    };

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Provisions</h1>
                    <p className="text-gray-500 text-sm mt-1">Manage procurement requests and delivery tracking.</p>
                </div>
                <div className="flex gap-3">
                    <button className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 text-sm font-medium transition-colors">
                        <Download className="w-4 h-4" />
                        Export
                    </button>
                    <button
                        onClick={() => setIsModalOpen(true)}
                        className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-700 text-sm font-medium shadow-lg shadow-primary-600/30 transition-all active:scale-95"
                    >
                        <Plus className="w-4 h-4" />
                        Create Provision
                    </button>
                </div>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="p-5 border-b border-gray-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="relative flex-1 max-w-md">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Search provisions..."
                            className="w-full pl-10 pr-4 py-2 bg-gray-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-primary-100 focus:bg-white transition-all"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </div>

                    {searchTerm && (
                        <div className="flex items-center gap-2 animate-in slide-in-from-right-4 duration-300">
                            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Active Filter</span>
                            <button
                                onClick={() => setSearchTerm('')}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-xs font-bold hover:bg-primary-100 transition-colors"
                            >
                                "{searchTerm}" <X className="w-3 h-3 text-primary-400" />
                            </button>
                        </div>
                    )}
                </div>

                <div className="overflow-x-auto">
                    {loading ? (
                        <div className="flex items-center justify-center p-12 text-gray-500">
                            <Loader2 className="w-8 h-8 animate-spin mr-2" />
                            Loading provisions...
                        </div>
                    ) : (
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-gray-50/50 text-gray-500 text-xs font-semibold uppercase tracking-wider">
                                    <th className="px-6 py-4">ID / Date</th>
                                    <th className="px-6 py-4">OEM</th>
                                    <th className="px-6 py-4">Product</th>
                                    <th className="px-6 py-4 text-center">Qty</th>
                                    <th className="px-6 py-4 text-right">Value</th>
                                    <th className="px-6 py-4">Expected Delivery</th>
                                    <th className="px-6 py-4 text-center">Status</th>
                                    <th className="px-6 py-4 text-right">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {filtered.length === 0 ? (
                                    <tr>
                                        <td colSpan={8} className="px-6 py-8 text-center text-gray-400 text-sm">No provisions found.</td>
                                    </tr>
                                ) : filtered.map((provision) => (
                                    <tr key={provision.id} className="hover:bg-gray-50/50 transition-colors">
                                        <td className="px-6 py-4">
                                            <span className="font-medium text-gray-900 block">{provision.id}</span>
                                            <span className="text-xs text-gray-400">{provision.created_at}</span>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-bold text-xs">
                                                    {provision.oem_name.substring(0, 2).toUpperCase()}
                                                </div>
                                                <span className="text-sm text-gray-700 font-medium">{provision.oem_name}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-600">{provision.product_model}</td>
                                        <td className="px-6 py-4 text-center">
                                            <span className="px-2 py-1 bg-gray-100 rounded-lg text-xs font-semibold text-gray-700">{provision.quantity}</span>
                                        </td>
                                        <td className="px-6 py-4 text-right font-medium text-gray-900">₹{provision.total_value.toLocaleString()}</td>
                                        <td className="px-6 py-4">
                                            {provision.expected_delivery_date ? (
                                                <div className="flex items-center gap-2 text-xs text-gray-600 bg-gray-50 px-2 py-1 rounded-md w-fit">
                                                    <Calendar className="w-3 h-3 text-gray-400" />
                                                    {provision.expected_delivery_date}
                                                </div>
                                            ) : (
                                                <span className="text-xs text-gray-400">-</span>
                                            )}
                                        </td>
                                        <td className="px-6 py-4 text-center">
                                            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${getStatusStyle(provision.status)}`}>
                                                {provision.status}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <button className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-400 transition-colors">
                                                <MoreHorizontal className="w-4 h-4" />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>

            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                            <h2 className="text-lg font-bold text-gray-900">Create New Provision</h2>
                            <button
                                onClick={() => setIsModalOpen(false)}
                                className="p-2 hover:bg-gray-100 rounded-lg text-gray-400 transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <form onSubmit={handleCreate} className="p-6 space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-1">
                                    <label className="text-sm font-semibold text-gray-700">OEM Name</label>
                                    <input
                                        required
                                        type="text"
                                        placeholder="e.g. Livguard"
                                        className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-100 focus:bg-white focus:border-primary-500 transition-all outline-none"
                                        value={formData.oem_name}
                                        onChange={(e) => setFormData({ ...formData, oem_name: e.target.value })}
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-sm font-semibold text-gray-700">Product Model</label>
                                    <input
                                        required
                                        type="text"
                                        placeholder="e.g. 48V 40Ah"
                                        className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-100 focus:bg-white focus:border-primary-500 transition-all outline-none"
                                        value={formData.product_model}
                                        onChange={(e) => setFormData({ ...formData, product_model: e.target.value })}
                                    />
                                </div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-1">
                                    <label className="text-sm font-semibold text-gray-700">Quantity</label>
                                    <input
                                        required
                                        type="number"
                                        placeholder="0"
                                        className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-100 focus:bg-white focus:border-primary-500 transition-all outline-none"
                                        value={formData.quantity}
                                        onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-sm font-semibold text-gray-700">Unit Price (₹)</label>
                                    <input
                                        required
                                        type="number"
                                        placeholder="0"
                                        className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-100 focus:bg-white focus:border-primary-500 transition-all outline-none"
                                        value={formData.unit_price}
                                        onChange={(e) => setFormData({ ...formData, unit_price: e.target.value })}
                                    />
                                </div>
                            </div>
                            <div className="pt-4 flex gap-3">
                                <button
                                    type="button"
                                    onClick={() => setIsModalOpen(false)}
                                    className="flex-1 px-4 py-2 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 text-sm font-semibold transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={isCreating}
                                    className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-xl hover:bg-primary-700 text-sm font-semibold shadow-lg shadow-primary-600/30 transition-all active:scale-95 disabled:opacity-70 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                >
                                    {isCreating ? (
                                        <>
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            Creating...
                                        </>
                                    ) : (
                                        'Create Provision'
                                    )}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};