'use client';

import { useState } from 'react';
import ProductCatalogForm from '@/components/forms/product-catalog-form';
import ProductCatalogList from '@/components/catalog/ProductCatalogList';
import { Plus, List } from 'lucide-react';

export default function ProductCatalogPage() {
    const [view, setView] = useState<'list' | 'create'>('list');

    return (
        <div className="min-h-screen py-8">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

                {/* page header */}
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
                    <div>
                        <h1 className="text-2xl font-bold text-gray-800">Product Catalog</h1>
                        <p className="text-gray-500 mt-1">Manage inventory assets and battery specifications</p>
                    </div>

                    <div className="flex bg-white p-1 rounded-xl border border-gray-100 shadow-sm">
                        <button
                            onClick={() => setView('list')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${view === 'list'
                                    ? 'bg-brand-50 text-brand-700 shadow-sm'
                                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                                }`}
                        >
                            <List className="w-4 h-4" />
                            List View
                        </button>
                        <button
                            onClick={() => setView('create')}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${view === 'create'
                                    ? 'bg-brand-50 text-brand-700 shadow-sm'
                                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                                }`}
                        >
                            <Plus className="w-4 h-4" />
                            Add Product
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="transition-all duration-300">
                    {view === 'list' ? <ProductCatalogList /> : <ProductCatalogForm />}
                </div>
            </div>
        </div>
    );
}
