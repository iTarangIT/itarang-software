'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

type DealerApplication = {
  dealerId: string;
  dealerName: string;
  companyName: string;
  companyType: string;
  documentsUploaded: number;
  totalDocuments: number;
  agreementStatus: string;
  onboardingStatus: string;
};

export default function DealerVerificationConsolePage() {
  const [items, setItems] = useState<DealerApplication[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadApplications = async () => {
      try {
        const res = await fetch('/api/admin/dealer-verifications');
        const data = await res.json();
        if (data.success) {
          setItems(data.data || []);
        }
      } catch (error) {
        console.error('Failed to load dealer verification queue', error);
      } finally {
        setLoading(false);
      }
    };

    loadApplications();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dealer Verification Console</h1>
        <p className="mt-1 text-sm text-gray-500">
          Review dealer onboarding submissions and activate approved accounts.
        </p>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 border-b border-gray-100 px-6 py-4">
          <div className="rounded-xl bg-emerald-50 p-2">
            <ShieldCheck className="h-5 w-5 text-emerald-700" />
          </div>
          <div>
            <h2 className="font-semibold text-gray-900">Applications Queue</h2>
            <p className="text-sm text-gray-500">Pending admin review and correction cases</p>
          </div>
        </div>

        {loading ? (
          <div className="p-6 text-sm text-gray-500">Loading applications...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-gray-500">
                <tr>
                  <th className="px-6 py-4 font-medium">Dealer</th>
                  <th className="px-6 py-4 font-medium">Company</th>
                  <th className="px-6 py-4 font-medium">Documents</th>
                  <th className="px-6 py-4 font-medium">Agreement</th>
                  <th className="px-6 py-4 font-medium">Status</th>
                  <th className="px-6 py-4 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.dealerId} className="border-t border-gray-100">
                    <td className="px-6 py-4 font-medium text-gray-900">{item.dealerName}</td>
                    <td className="px-6 py-4 text-gray-700">{item.companyName}</td>
                    <td className="px-6 py-4 text-gray-700">
                      {item.documentsUploaded}/{item.totalDocuments}
                    </td>
                    <td className="px-6 py-4 text-gray-700">{item.agreementStatus}</td>
                    <td className="px-6 py-4 text-gray-700">{item.onboardingStatus}</td>
                    <td className="px-6 py-4">
                      <Link
                        href={`/admin/dealer-verification/${item.dealerId}`}
                        className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Review
                      </Link>
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-10 text-center text-sm text-gray-500">
                      No dealer applications found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}