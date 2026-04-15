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
    lead_status: z.enum(['new', 'assigned', 'contacted', 'qualified', 'converted', 'lost']),
    business_name: z.string().optional(),
    owner_email: z.string().email().optional().or(z.literal('')),
    shop_address: z.string().optional(),
});

type LeadFormData = z.infer<typeof leadSchema>;

interface EditLeadFormProps {
    initialData: any; // Using any for simplicity with Supabase return type, ideally strictly typed
    leadId: string;
}

export function EditLeadForm({ initialData, leadId }: EditLeadFormProps) {
    const router = useRouter();
    const [submitting, setSubmitting] = useState(false);
    const { register, handleSubmit, formState: { errors } } = useForm<LeadFormData>({
        resolver: zodResolver(leadSchema),
        defaultValues: {
            lead_source: initialData.lead_source,
            owner_name: initialData.owner_name,
            owner_contact: initialData.owner_contact,
            state: initialData.state,
            city: initialData.city,
            interest_level: initialData.interest_level,
            lead_status: initialData.lead_status,
            business_name: initialData.business_name || '',
            owner_email: initialData.owner_email || '',
            shop_address: initialData.shop_address || '',
        }
    });

    const onSubmit = async (data: LeadFormData) => {
        setSubmitting(true);
        try {
            const res = await fetch(`/api/leads/${leadId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error?.message || 'Failed to update lead');
            }

            // Show success logic here? Using alert for now as per previous patterns
            alert('Lead updated successfully');
            router.push('/leads');
            router.refresh();
        } catch (error: any) {
            console.error(error);
            alert(error.message || 'Error updating lead');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 bg-white p-6 rounded-xl border border-gray-100 shadow-sm">
            {/* Lead ID - Read Only */}
            <div className="space-y-2">
                <Label className="text-gray-500">Lead ID</Label>
                <Input value={leadId} disabled className="bg-gray-100 text-gray-500" />
            </div>

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
                </div>
            </div>

            <div className="space-y-2">
                <Label>Status</Label>
                <Select {...register('lead_status')} error={!!errors.lead_status}>
                    <option value="new">New</option>
                    <option value="assigned">Assigned</option>
                    <option value="contacted">Contacted</option>
                    <option value="qualified">Qualified</option>
                    <option value="converted">Converted</option>
                    <option value="lost">Lost</option>
                </Select>
            </div>

            {/* Owner Details */}
            <div className="space-y-2">
                <Label>Lead Owner Name <span className="text-red-500">*</span></Label>
                <Input {...register('owner_name')} error={!!errors.owner_name} />
                {errors.owner_name && <p className="text-red-500 text-xs">{errors.owner_name.message}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                    <Label>Contact Number <span className="text-red-500">*</span></Label>
                    <Input {...register('owner_contact')} error={!!errors.owner_contact} />
                    {errors.owner_contact && <p className="text-red-500 text-xs">{errors.owner_contact.message}</p>}
                </div>
                <div className="space-y-2">
                    <Label>Email (Optional)</Label>
                    <Input {...register('owner_email')} type="email" />
                    {errors.owner_email && <p className="text-red-500 text-xs">{errors.owner_email.message}</p>}
                </div>
            </div>

            <div className="space-y-2">
                <Label>Business Name (Optional)</Label>
                <Input {...register('business_name')} />
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

            <div className="space-y-2">
                <Label>Shop Address (Optional)</Label>
                <Input {...register('shop_address')} />
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t mt-6">
                <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
                <Button type="submit" disabled={submitting}>
                    {submitting ? 'Updating...' : 'Update Lead'}
                </Button>
            </div>
        </form>
    );
}
