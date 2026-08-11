'use client';

// Edit form for a dealer lead (/leads/[id]/edit).
//
// This form was previously bound to the WRONG ENTITY. Its fields were named for
// the customer/loan `leads` table (owner_name, owner_contact, lead_source,
// business_name, shop_address) while the page hands it a `dealer_leads` row
// (dealer_name, phone, source, shop_name, location). So `defaultValues` matched
// almost nothing and the form opened blank, with zod's min(1)/min(10) on two
// fields that could never be populated. It then PUT to /api/leads/[id], which
// queries `leads` — a `DL-…` id is never there, so every save 404'd — and the
// response was never checked, so it redirected to /leads looking successful.
//
// Now: real dealer_leads columns, a real endpoint, and errors are surfaced.
//
// Lifecycle fields are deliberately absent. Status, interest level and owner all
// have guarded, audited routes of their own (see the comment block in
// src/app/api/dealer-leads/[id]/route.ts); editing them from a free-form details
// screen would bypass the transition rules and the audit trail.

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Mirrors PatchSchema in src/app/api/dealer-leads/[id]/route.ts. The server
// re-validates and normalises regardless — this is only for fast feedback.
const leadSchema = z.object({
  dealer_name: z.string().trim().min(1, 'Dealer name is required'),
  phone: z
    .string()
    .trim()
    .min(10, 'Enter a valid 10-digit Indian mobile number'),
  shop_name: z.string().trim().optional(),
  language: z.string().trim().optional(),
  source: z.string().trim().optional(),
  state: z.string().trim().optional(),
  city: z.string().trim().optional(),
  area: z.string().trim().optional(),
  pincode: z.string().trim().optional(),
  overall_summary: z.string().trim().optional(),
});

type LeadFormData = z.infer<typeof leadSchema>;

// dealer_leads.source vocabulary (E-126) — the values the rest of the pipeline
// and BRD §0.11 Report 5 already group by. NOT the `leads` table's lead_source.
const SOURCE_OPTIONS = [
  { value: '', label: '—' },
  { value: 'ai_dialer_lead', label: 'AI Dialer' },
  { value: 'manual_upload_lead', label: 'Manual Upload' },
  { value: 'reference', label: 'Reference' },
  { value: 'trade_show', label: 'Trade Show' },
  { value: 'other', label: 'Other' },
];

type DealerLeadRow = {
  dealer_name: string | null;
  phone: string | null;
  shop_name: string | null;
  language: string | null;
  source: string | null;
  state: string | null;
  city: string | null;
  area: string | null;
  pincode: string | null;
  overall_summary: string | null;
};

export function EditLeadForm({
  initialData,
  leadId,
}: {
  initialData: DealerLeadRow;
  leadId: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LeadFormData>({
    resolver: zodResolver(leadSchema),
    // Every key here exists on a dealer_leads row, so the form actually opens
    // populated. `?? ''` keeps the inputs controlled when a column is NULL.
    defaultValues: {
      dealer_name: initialData.dealer_name ?? '',
      phone: initialData.phone ?? '',
      shop_name: initialData.shop_name ?? '',
      language: initialData.language ?? '',
      source: initialData.source ?? '',
      state: initialData.state ?? '',
      city: initialData.city ?? '',
      area: initialData.area ?? '',
      pincode: initialData.pincode ?? '',
      overall_summary: initialData.overall_summary ?? '',
    },
  });

  const onSubmit = async (data: LeadFormData) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dealer-leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json().catch(() => null);
      // The whole point of the rewrite: a failed save must NOT look like a
      // successful one. Stay on the page and say what went wrong.
      if (!res.ok || !json?.success) {
        throw new Error(
          json?.error?.message ?? `Could not save the lead (HTTP ${res.status}).`,
        );
      }
      toast.success('Lead updated.');
      router.push('/leads');
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-8">
      {/* SECTION 1 — identity */}
      <div className="space-y-5">
        <h2 className="text-lg font-semibold text-gray-900">Dealer Details</h2>

        <div className="grid md:grid-cols-2 gap-5">
          <div>
            <Label>Dealer Name <span className="text-rose-600">*</span></Label>
            <Input {...register('dealer_name')} className="mt-1" />
            {errors.dealer_name && (
              <p className="mt-1 text-xs text-rose-600">
                {errors.dealer_name.message}
              </p>
            )}
          </div>

          <div>
            <Label>Shop / Business Name</Label>
            <Input {...register('shop_name')} className="mt-1" />
          </div>

          <div>
            <Label>Phone <span className="text-rose-600">*</span></Label>
            <Input {...register('phone')} className="mt-1" />
            {errors.phone ? (
              <p className="mt-1 text-xs text-rose-600">
                {errors.phone.message}
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-gray-400">
                Normalised to +91 on save. Must be unique across leads.
              </p>
            )}
          </div>

          <div>
            <Label>Language</Label>
            <Input {...register('language')} className="mt-1" placeholder="e.g. hi, en" />
          </div>

          <div>
            <Label>Source</Label>
            <select
              {...register('source')}
              className="mt-1 w-full rounded-lg border px-3 py-2 focus:ring-2 focus:ring-blue-500"
            >
              {SOURCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* SECTION 2 — region */}
      <div className="space-y-5">
        <h2 className="text-lg font-semibold text-gray-900">Location</h2>
        <p className="-mt-3 text-[11px] text-gray-500">
          State and city are canonicalised on save — they drive the region
          filters and the AI dialer&apos;s audience.
        </p>

        <div className="grid md:grid-cols-2 gap-5">
          <div>
            <Label>State</Label>
            <Input {...register('state')} className="mt-1" />
          </div>
          <div>
            <Label>City</Label>
            <Input {...register('city')} className="mt-1" />
          </div>
          <div>
            <Label>Area</Label>
            <Input {...register('area')} className="mt-1" />
          </div>
          <div>
            <Label>Pincode</Label>
            <Input {...register('pincode')} className="mt-1" />
          </div>
        </div>
      </div>

      {/* SECTION 3 — notes */}
      <div className="space-y-5">
        <h2 className="text-lg font-semibold text-gray-900">Notes</h2>
        <div>
          <Label>Summary</Label>
          <textarea
            {...register('overall_summary')}
            rows={4}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
            placeholder="Anything worth knowing about this dealer…"
          />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-between border-t pt-5">
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button
          type="submit"
          className="bg-blue-600 hover:bg-blue-700"
          disabled={loading}
        >
          {loading ? 'Updating…' : 'Update Lead'}
        </Button>
      </div>
    </form>
  );
}
