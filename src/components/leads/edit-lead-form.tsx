'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const leadSchema = z.object({
  lead_source: z.string(),
  owner_name: z.string().min(1),
  owner_contact: z.string().min(10),
  state: z.string().min(1),
  city: z.string().min(1),
  interest_level: z.string(),
  lead_status: z.string(),
  business_name: z.string().optional(),
  owner_email: z.string().optional(),
  shop_address: z.string().optional(),
});

type LeadFormData = z.infer<typeof leadSchema>;

export function EditLeadForm({ initialData, leadId }: any) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const { register, handleSubmit, formState: { errors } } = useForm<LeadFormData>({
    resolver: zodResolver(leadSchema),
    defaultValues: initialData
  });

  const onSubmit = async (data: LeadFormData) => {
    setLoading(true);
    try {
      await fetch(`/api/leads/${leadId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      router.push('/leads');
      router.refresh();
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-10">

      {/* SECTION 1 */}
      <div className="bg-white rounded-xl shadow-sm p-6 space-y-5">
        <h2 className="text-lg font-semibold text-gray-900">
          Lead Information
        </h2>

        <div className="grid md:grid-cols-3 gap-5">

          <div>
            <Label className="text-gray-600">Source</Label>
            <select {...register('lead_source')} className="mt-1 w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500">
              <option value="call_center">Call Center</option>
              <option value="ground_sales">Ground Sales</option>
              <option value="digital_marketing">Digital Marketing</option>
            </select>
          </div>

          <div>
            <Label className="text-gray-600">Interest</Label>
            <select {...register('interest_level')} className="mt-1 w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500">
              <option value="cold">Cold</option>
              <option value="warm">Warm</option>
              <option value="hot">Hot</option>
            </select>
          </div>

          <div>
            <Label className="text-gray-600">Status</Label>
            <select {...register('lead_status')} className="mt-1 w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500">
              <option value="new">New</option>
              <option value="qualified">Qualified</option>
              <option value="converted">Converted</option>
            </select>
          </div>

        </div>
      </div>

      {/* SECTION 2 */}
      <div className="bg-white rounded-xl shadow-sm p-6 space-y-5">
        <h2 className="text-lg font-semibold text-gray-900">
          Owner Details
        </h2>

        <div className="grid md:grid-cols-2 gap-5">

          <div>
            <Label>Owner Name</Label>
            <Input {...register('owner_name')} />
            {errors.owner_name && <p className="text-xs text-red-500 mt-1">Required</p>}
          </div>

          <div>
            <Label>Business Name</Label>
            <Input {...register('business_name')} />
          </div>

          <div>
            <Label>Phone</Label>
            <Input {...register('owner_contact')} />
          </div>

          <div>
            <Label>Email</Label>
            <Input {...register('owner_email')} />
          </div>

        </div>
      </div>

      {/* SECTION 3 */}
      <div className="bg-white rounded-xl shadow-sm p-6 space-y-5">
        <h2 className="text-lg font-semibold text-gray-900">
          Location
        </h2>

        <div className="grid md:grid-cols-2 gap-5">

          <div>
            <Label>State</Label>
            <Input {...register('state')} />
          </div>

          <div>
            <Label>City</Label>
            <Input {...register('city')} />
          </div>

        </div>

        <div>
          <Label>Shop Address</Label>
          <Input {...register('shop_address')} />
        </div>
      </div>

      {/* ACTION */}
      <div className="flex justify-between items-center pt-4">

        <Button
          type="button"
          variant="ghost"
          onClick={() => router.back()}
        >
          Cancel
        </Button>

        <Button
          type="submit"
          className="bg-blue-600 hover:bg-blue-700"
          disabled={loading}
        >
          {loading ? 'Updating...' : 'Update Lead'}
        </Button>

      </div>

    </form>
  );
}