'use client';

import React, { useMemo, useState, useEffect } from 'react';

const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

interface DatePickerProps {
    value: string; // YYYY-MM-DD format
    onChange: (value: string) => void;
    minAge?: number;
    maxYear?: number;
    minYear?: number;
    error?: boolean;
    className?: string;
}

export function DatePicker({
    value,
    onChange,
    minAge = 18,
    maxYear,
    minYear = 1940,
    error = false,
    className = '',
}: DatePickerProps) {
    const currentYear = new Date().getFullYear();
    const effectiveMaxYear = maxYear ?? currentYear - minAge;

    // Internal state so partial selections persist visually
    const [internalDay, setInternalDay] = useState('');
    const [internalMonth, setInternalMonth] = useState('');
    const [internalYear, setInternalYear] = useState('');

    // Sync internal state when value prop changes externally (e.g. draft resume)
    useEffect(() => {
        if (!value) {
            setInternalDay('');
            setInternalMonth('');
            setInternalYear('');
            return;
        }
        const [y, m, d] = value.split('-');
        if (y) setInternalYear(y);
        if (m) setInternalMonth(String(Number(m))); // remove leading zero for select match
        if (d) setInternalDay(String(Number(d)));    // remove leading zero for select match
    }, [value]);

    const years = useMemo(() => {
        const arr: number[] = [];
        for (let y = effectiveMaxYear; y >= minYear; y--) arr.push(y);
        return arr;
    }, [effectiveMaxYear, minYear]);

    const daysInMonth = useMemo(() => {
        if (!internalYear || !internalMonth) return 31;
        return new Date(Number(internalYear), Number(internalMonth), 0).getDate();
    }, [internalYear, internalMonth]);

    const days = useMemo(() => {
        const arr: number[] = [];
        for (let d = 1; d <= daysInMonth; d++) arr.push(d);
        return arr;
    }, [daysInMonth]);

    const age = useMemo(() => {
        if (!internalYear || !internalMonth || !internalDay) return null;
        const today = new Date();
        const birth = new Date(Number(internalYear), Number(internalMonth) - 1, Number(internalDay));
        let a = today.getFullYear() - birth.getFullYear();
        const monthDiff = today.getMonth() - birth.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) a--;
        return a;
    }, [internalDay, internalMonth, internalYear]);

    const handleChange = (field: 'day' | 'month' | 'year', val: string) => {
        const nextDay = field === 'day' ? val : internalDay;
        const nextMonth = field === 'month' ? val : internalMonth;
        const nextYear = field === 'year' ? val : internalYear;

        if (field === 'day') setInternalDay(val);
        if (field === 'month') setInternalMonth(val);
        if (field === 'year') setInternalYear(val);

        if (nextYear && nextMonth && nextDay) {
            const dd = nextDay.padStart(2, '0');
            const mm = nextMonth.padStart(2, '0');
            onChange(`${nextYear}-${mm}-${dd}`);
        } else if (!nextYear && !nextMonth && !nextDay) {
            onChange('');
        }
    };

    const selectClass = `h-11 bg-white border-2 rounded-xl outline-none transition-all text-sm px-3 focus:border-[#1D4ED8] focus:ring-4 focus:ring-blue-50/50 ${error ? 'border-red-500' : 'border-[#EBEBEB]'}`;

    return (
        <div className={className}>
            <div className="flex gap-2">
                <select
                    value={internalDay}
                    onChange={e => handleChange('day', e.target.value)}
                    className={`${selectClass} w-[90px]`}
                    aria-label="Day"
                >
                    <option value="">Day</option>
                    {days.map(d => (
                        <option key={d} value={String(d)}>{d}</option>
                    ))}
                </select>

                <select
                    value={internalMonth}
                    onChange={e => handleChange('month', e.target.value)}
                    className={`${selectClass} flex-1`}
                    aria-label="Month"
                >
                    <option value="">Month</option>
                    {MONTHS.map((m, i) => (
                        <option key={m} value={String(i + 1)}>{m}</option>
                    ))}
                </select>

                <select
                    value={internalYear}
                    onChange={e => handleChange('year', e.target.value)}
                    className={`${selectClass} w-[100px]`}
                    aria-label="Year"
                >
                    <option value="">Year</option>
                    {years.map(y => (
                        <option key={y} value={String(y)}>{y}</option>
                    ))}
                </select>
            </div>

            {age !== null && age >= 0 && (
                <p className={`text-xs mt-1.5 ${age < minAge ? 'text-red-500' : 'text-green-600'}`}>
                    Age: {age} years{age < minAge ? ` (must be at least ${minAge})` : ''}
                </p>
            )}
        </div>
    );
}
