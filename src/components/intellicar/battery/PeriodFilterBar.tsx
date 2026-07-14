'use client';

import { cn } from '@/lib/utils';
import { CustomRangePicker } from './CustomRangePicker';
import { MonthPicker } from './MonthPicker';
import { GRANULARITIES, PERIODS, type Period } from './usePeriod';

/**
 * The period controls, in precedence order left-to-right: custom range, a specific
 * calendar month, then the rolling window. Whichever is set last wins, and usePeriod
 * clears the others — so the highlighted control is always the one the server used.
 *
 * Granularity is a separate control because it answers a different question: the window says
 * *how much* history, the grain says *how finely* it is sliced. Only the charts that bucket
 * over time read it; the per-cycle charts ignore it.
 */
export function PeriodFilterBar({
    period,
    showGranularity = false,
}: {
    period: Period;
    showGranularity?: boolean;
}) {
    const { months, month, range, granularity, setMonths, setMonth, setRange, setGranularity } = period;

    return (
        <div className="flex flex-wrap items-center gap-2">
            {showGranularity && (
                <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-lg">
                    {GRANULARITIES.map((g) => (
                        <button
                            key={g.value}
                            type="button"
                            onClick={() => setGranularity(g.value)}
                            className={cn(
                                'px-2.5 py-1.5 rounded-md text-xs font-medium transition-all',
                                granularity === g.value
                                    ? 'bg-white text-brand-700 shadow-sm'
                                    : 'text-gray-500 hover:text-gray-700',
                            )}
                        >
                            {g.label}
                        </button>
                    ))}
                </div>
            )}

            <CustomRangePicker value={range} onChange={setRange} />
            <MonthPicker
                value={month}
                onChange={setMonth}
                max={new Date().toISOString().slice(0, 7)}
            />
            <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-lg">
                {PERIODS.map((p) => (
                    <button
                        key={p.value}
                        type="button"
                        onClick={() => setMonths(p.value)}
                        className={cn(
                            'px-3 py-1.5 rounded-md text-sm font-medium transition-all',
                            !month && !range && months === p.value
                                ? 'bg-white text-brand-700 shadow-sm'
                                : 'text-gray-500 hover:text-gray-700',
                        )}
                    >
                        {p.label}
                    </button>
                ))}
            </div>
        </div>
    );
}
