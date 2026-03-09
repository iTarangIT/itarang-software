'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const leadSchema = z.object({
    lead_source: z.enum(['call_center', 'ground_sales', 'digital_marketing', 'database_upload', 'dealer_referral']),
    owner_name: z.string().min(1, 'Lead Owner Name is required'),
    owner_contact: z.string().regex(/^\+91[0-9]{10}$/, "Must be +91 followed by 10 digits"),
    state: z.string().min(1, 'State is required'),
    city: z.string().min(1, 'City is required'),
    interest_level: z.enum(['cold', 'warm', 'hot']),
    business_name: z.string().optional(),
    owner_email: z.string().email().optional().or(z.literal('')),
    shop_address: z.string().optional(),
});

type LeadFormData = z.infer<typeof leadSchema>;

export default function NewLeadPage() {
    const router = useRouter();
    const [submitting, setSubmitting] = useState(false);
    const { register, handleSubmit, formState: { errors } } = useForm<LeadFormData>({
        resolver: zodResolver(leadSchema),
        defaultValues: {
            interest_level: 'cold',
            lead_source: 'ground_sales',
            owner_contact: '+91',
        }
    });

    const onSubmit = async (data: LeadFormData) => {
        setSubmitting(true);
        try {
            const res = await fetch('/api/leads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error?.message || 'Failed to create lead');
            }

            router.push('/leads'); // Redirect to list
            router.refresh();
        } catch (error: any) {
            console.error(error);
            alert(error.message || 'Error creating lead');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="max-w-2xl mx-auto py-8 px-4">
            <h1 className="text-2xl font-bold mb-6 text-gray-900">Create New Lead</h1>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 bg-white p-6 rounded-xl border border-gray-100 shadow-sm">

                {/* Basic Info */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label>Lead Source</Label>
                        <Select {...register('lead_source')} error={!!errors.lead_source}>
                            <option value="call_center">Call Center</option>
                            <option value="ground_sales">Ground Sales</option>
                            <option value="digital_marketing">Digital Marketing</option>
                            <option value="dealer_referral">Dealer Referral</option>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <Label>Interest Level <span className="text-red-500">*</span></Label>
                        <Select {...register('interest_level')} error={!!errors.interest_level}>
                            <option value="cold">Cold</option>
                            <option value="warm">Warm</option>
                            <option value="hot">Hot</option>
                        </Select>
                        <p className="text-xs text-gray-500">Only Warm/Hot leads can be qualified.</p>
                    </div>
                </div>

                {/* Owner Details */}
                <div className="space-y-2">
                    <Label>Lead Owner Name <span className="text-red-500">*</span></Label>
                    <Input {...register('owner_name')} error={!!errors.owner_name} placeholder="e.g. Rahul Kumar" />
                    {errors.owner_name && <p className="text-red-500 text-xs">{errors.owner_name.message}</p>}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label>Contact Number <span className="text-red-500">*</span></Label>
                        <Input {...register('owner_contact')} error={!!errors.owner_contact} placeholder="+91..." />
                        {errors.owner_contact && <p className="text-red-500 text-xs">{errors.owner_contact.message}</p>}
                    </div>
                    <div className="space-y-2">
                        <Label>Email (Optional)</Label>
                        <Input {...register('owner_email')} type="email" placeholder="rahul@example.com" />
                        {errors.owner_email && <p className="text-red-500 text-xs">{errors.owner_email.message}</p>}
                    </div>
                </div>

                <div className="space-y-2">
                    <Label>Business Name (Optional)</Label>
                    <Input {...register('business_name')} placeholder="e.g. Rahul EV Motors" />
                </div>

                {/* Location */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label>State <span className="text-red-500">*</span></Label>
                        <Input {...register('state')} error={!!errors.state} />
                        {errors.state && <p className="text-red-500 text-xs">{errors.state.message}</p>}
                    </div>
                    <div className="space-y-2">
                        <Label>City <span className="text-red-500">*</span></Label>
                        <Input {...register('city')} error={!!errors.city} />
                        {errors.city && <p className="text-red-500 text-xs">{errors.city.message}</p>}
                    </div>
                </div>

                <div className="flex justify-end gap-2 pt-4 border-t mt-6">
                    <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
                    <Button type="submit" disabled={submitting}>
                        {submitting ? 'Creating...' : 'Create Lead'}
                    </Button>
                </div>
            </form>
        </div>
    );
}
