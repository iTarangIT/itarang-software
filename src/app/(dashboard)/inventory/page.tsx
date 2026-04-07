
import InventoryList from '@/components/inventory/InventoryList';

export default function InventoryPage() {
    return (
        <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
            <div className="max-w-7xl mx-auto">
                <div className="text-center mb-12">
                    <h1 className="text-3xl font-extrabold text-gray-900 sm:text-4xl">
                        Inventory Management
                    </h1>
                    <p className="mt-4 text-xl text-gray-500">
                        View current stock and export reports.
                    </p>
                </div>

                <InventoryList />
            </div>
        </div>
    );
}
