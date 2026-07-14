'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Downloads the Charging Analysis workbook for the selected battery and period.
 *
 * Fetches into a blob rather than using a plain <a href> so the button can show a
 * spinner and, on a rejected range, surface the API's explanation ("choose a
 * narrower date range") instead of silently navigating.
 */
export function ExportChargingAnalysis({
    battery,
    periodParam,
    fileSuffix,
}: {
    battery: string;
    periodParam: string;
    fileSuffix: string;
}) {
    const [loading, setLoading] = useState(false);

    const download = async () => {
        setLoading(true);
        try {
            const res = await fetch(
                `/api/telemetry/analytics/charging-export.xlsx?vehicleno=${encodeURIComponent(battery)}&${periodParam}`,
            );
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error?.message ?? 'Export failed');
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `charging-analysis_${battery}_${fileSuffix}.xlsx`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Export failed');
        } finally {
            setLoading(false);
        }
    };

    return (
        <button
            type="button"
            onClick={download}
            disabled={!battery || loading}
            title={battery ? undefined : 'Select a battery first'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-brand-600 text-white transition-colors hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {loading ? 'Preparing…' : 'Download Charging Analysis'}
        </button>
    );
}
