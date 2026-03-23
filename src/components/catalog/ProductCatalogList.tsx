
'use client';

import { useState, useEffect } from 'react';

type Product = {
    id: string;
    name: string;
    asset_category: string;
    asset_type: string;
    status: string;
    warranty_months: number;
    created_at: string;
};

export default function ProductCatalogList() {
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchProducts = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/product-catalog');
            const data = await res.json();
            if (data.success) {
                setProducts(data.data);
            }
        } catch (error) {
            console.error('Failed to fetch products:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchProducts();
    }, []);

    return (
        <div className="card-parcel">
            <div className="overflow-x-auto">
                <table className="w-full text-sm text-left text-gray-500">
                    <thead className="text-xs text-gray-400 uppercase bg-gray-50/50">
                        <tr>
                            <th className="px-6 py-4 font-medium tracking-wider">Model Type</th>
                            <th className="px-6 py-4 font-medium tracking-wider">Category</th>
                            <th className="px-6 py-4 font-medium tracking-wider">Type</th>
                            <th className="px-6 py-4 font-medium tracking-wider">Warranty (Mos)</th>
                            <th className="px-6 py-4 font-medium tracking-wider">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading ? (
                            <tr><td colSpan={5} className="text-center py-8 text-gray-400">Loading...</td></tr>
                        ) : products.length === 0 ? (
                            <tr><td colSpan={5} className="text-center py-8 text-gray-400">No products found</td></tr>
                        ) : (
                            products.map((product) => (
                                <tr key={product.id} className="table-row-parcel group">
                                    <td className="px-6 py-4 font-medium text-gray-900">{product.name}</td>
                                    <td className="px-6 py-4 text-gray-600">{product.asset_category}</td>
                                    <td className="px-6 py-4 text-gray-600">{product.asset_type}</td>
                                    <td className="px-6 py-4 text-gray-600">{product.warranty_months}</td>
                                    <td className="px-6 py-4">
                                        <span className={`status-pill ${product.status === 'active' ? 'bg-surface-teal text-brand-700' : 'bg-gray-100 text-gray-600'}`}>
                                            {product.status}
                                        </span>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
