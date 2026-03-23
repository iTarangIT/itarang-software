
export default function SalesHeadDetailPage({ params }: { params: { id: string } }) {
    return (
        <div className="p-8">
            <h1 className="text-2xl font-bold mb-4">Sales Manager Detail</h1>
            <p className="text-gray-600">Viewing details for manager ID: {params.id}</p>
            <div className="mt-8 p-6 bg-white rounded-xl border border-gray-100 shadow-sm">
                <p className="text-sm text-gray-500 italic">This page is a placeholder for detailed sales performance analytics.</p>
            </div>
        </div>
    );
}
