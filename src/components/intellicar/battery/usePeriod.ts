'use client';

import { useState } from 'react';

import type { Granularity } from './types';

export type Months = 1 | 3 | 6 | 12;

// Must match buildTimeWindow's whitelist on the server, or a selection silently falls back to
// the 3-month default and the caption describes a window the query never ran.
export const PERIODS: { value: Months; label: string }[] = [
    { value: 1, label: '1M' },
    { value: 3, label: '3M' },
    { value: 6, label: '6M' },
    { value: 12, label: '12M' },
];

export const GRANULARITIES: { value: Granularity; label: string }[] = [
    { value: 'day', label: 'Daily' },
    { value: 'week', label: 'Weekly' },
    { value: 'month', label: 'Monthly' },
];

export interface Period {
    months: Months;
    month: string;
    range: { from: string; to: string } | null;
    granularity: Granularity;
    setMonths: (m: Months) => void;
    setMonth: (m: string) => void;
    setRange: (r: { from: string; to: string } | null) => void;
    setGranularity: (g: Granularity) => void;
    /** Query-string fragment appended to every analytics endpoint. */
    periodParam: string;
    /** Human label for a chart caption. */
    periodLabel: string;
    /** Slug for a downloaded filename. */
    fileSuffix: string;
}

/**
 * The period selector shared by every chart on the Battery tab.
 *
 * The three modes are mutually exclusive and their precedence — custom range, then a
 * chosen month, then the rolling window — **must** match buildTimeWindow() on the server
 * (src/lib/telemetry/charging-sql.ts). If the two drift, a chart's caption describes a
 * period the query never ran. Selecting one mode clears the others rather than relying on
 * precedence alone, so what the controls show is what the server was asked for.
 */
export function usePeriod(initial: Months = 3): Period {
    const [months, setMonthsState] = useState<Months>(initial);
    const [month, setMonthState] = useState(''); // specific calendar month, YYYY-MM
    const [range, setRangeState] = useState<{ from: string; to: string } | null>(null); // YYYY-MM-DD
    const [granularity, setGranularity] = useState<Granularity>('day');

    const setMonths = (m: Months) => {
        setMonthsState(m);
        setMonthState('');
        setRangeState(null);
    };
    const setMonth = (m: string) => {
        setMonthState(m);
        if (m) setRangeState(null);
    };
    const setRange = (r: { from: string; to: string } | null) => {
        setRangeState(r);
        if (r) setMonthState('');
    };

    // Granularity is a separate axis from the window: it says how finely the window is sliced,
    // not how long it is. It rides along on the same query string so a chart can never bucket
    // by a grain the server did not group by.
    const periodParam =
        (range
            ? `from=${range.from}&to=${range.to}`
            : month
              ? `month=${month}`
              : `months=${months}`) + `&granularity=${granularity}`;

    const periodLabel = range
        ? `${range.from} to ${range.to}`
        : month
          ? new Date(`${month}-01T00:00:00`).toLocaleString('default', { month: 'long', year: 'numeric' })
          : `${months} Month${months > 1 ? 's' : ''}`;

    const fileSuffix = range ? `${range.from}_to_${range.to}` : month || `${months}m`;

    return {
        months,
        month,
        range,
        granularity,
        setMonths,
        setMonth,
        setRange,
        setGranularity,
        periodParam,
        periodLabel,
        fileSuffix,
    };
}
