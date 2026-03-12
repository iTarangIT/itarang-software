"use client";

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Power, PowerOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Schedule {
    id: string;
    frequency: string;
    day_of_week: number | null;
    time_of_day: string;
    is_active: boolean;
    last_run_at: string | null;
}

const FREQUENCY_OPTIONS = [
    { value: 'every_2_days', label: 'Every 2 Days' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'biweekly', label: 'Every 2 Weeks' },
    { value: 'monthly', label: 'Monthly' },
];

const DAY_OPTIONS = [
    { value: 0, label: 'Sunday' },
    { value: 1, label: 'Monday' },
    { value: 2, label: 'Tuesday' },
    { value: 3, label: 'Wednesday' },
    { value: 4, label: 'Thursday' },
    { value: 5, label: 'Friday' },
    { value: 6, label: 'Saturday' },
];

export function ScheduleConfig() {
    const queryClient = useQueryClient();
    const [frequency, setFrequency] = useState('every_2_days');
    const [dayOfWeek, setDayOfWeek] = useState(1);
    const [timeOfDay, setTimeOfDay] = useState('03:00');

    const { data: schedule, isLoading } = useQuery<Schedule | null>({
        queryKey: ['scraper-schedule'],
        queryFn: async () => {
            const res = await fetch('/api/scraper/schedule');
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
            return json.data;
        },
    });

    useEffect(() => {
        if (schedule) {
            setFrequency(schedule.frequency);
            setDayOfWeek(schedule.day_of_week ?? 1);
            setTimeOfDay(schedule.time_of_day);
        }
    }, [schedule]);

    const saveMutation = useMutation({
        mutationFn: async (active: boolean) => {
            const res = await fetch('/api/scraper/schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    frequency,
                    day_of_week: ['weekly', 'biweekly'].includes(frequency) ? dayOfWeek : undefined,
                    time_of_day: timeOfDay,
                    is_active: active,
                }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scraper-schedule'] }),
    });

    const showDayPicker = ['weekly', 'biweekly'].includes(frequency);

    if (isLoading) {
        return <div className="h-32 bg-gray-100 animate-pulse rounded-xl" />;
    }

    return (
        <div className="bg-white border border-gray-100 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-teal-600" />
                    <h3 className="text-sm font-semibold text-gray-700">Auto Schedule</h3>
                </div>
                {schedule?.is_active ? (
                    <span className="flex items-center gap-1 text-xs text-green-600 bg-green-50 px-2 py-1 rounded-full">
                        <Power className="w-3 h-3" /> Active
                    </span>
                ) : (
                    <span className="flex items-center gap-1 text-xs text-gray-400 bg-gray-50 px-2 py-1 rounded-full">
                        <PowerOff className="w-3 h-3" /> Off
                    </span>
                )}
            </div>

            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="block text-xs text-gray-500 mb-1">Frequency</label>
                    <select
                        value={frequency}
                        onChange={(e) => setFrequency(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                    >
                        {FREQUENCY_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                    </select>
                </div>

                <div>
                    <label className="block text-xs text-gray-500 mb-1">Time (IST)</label>
                    <input
                        type="time"
                        value={timeOfDay}
                        onChange={(e) => setTimeOfDay(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                </div>
            </div>

            {showDayPicker && (
                <div>
                    <label className="block text-xs text-gray-500 mb-1">Day</label>
                    <select
                        value={dayOfWeek}
                        onChange={(e) => setDayOfWeek(Number(e.target.value))}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                    >
                        {DAY_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                    </select>
                </div>
            )}

            {schedule?.last_run_at && (
                <p className="text-xs text-gray-400">
                    Last auto-run: {new Date(schedule.last_run_at).toLocaleString('en-IN')}
                </p>
            )}

            <div className="flex gap-2">
                <Button
                    size="sm"
                    className="bg-teal-600 hover:bg-teal-700 text-white text-xs"
                    onClick={() => saveMutation.mutate(true)}
                    disabled={saveMutation.isPending}
                >
                    {saveMutation.isPending ? 'Saving...' : 'Save & Enable'}
                </Button>
                {schedule?.is_active && (
                    <Button
                        size="sm"
                        variant="outline"
                        className="text-xs"
                        onClick={() => saveMutation.mutate(false)}
                        disabled={saveMutation.isPending}
                    >
                        Disable
                    </Button>
                )}
            </div>
        </div>
    );
}
