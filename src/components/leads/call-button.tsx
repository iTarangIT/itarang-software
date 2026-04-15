
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Phone, PhoneCall } from 'lucide-react';

interface CallButtonProps {
    leadId: string;
}

export function CallButton({ leadId }: CallButtonProps) {
    const [calling, setCalling] = useState(false);

    const handleCall = async () => {
        if (calling) return;

        setCalling(true);
        try {
            const response = await fetch('/api/calls', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ leadId }),
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error?.message || 'Failed to trigger call');
            }

            alert('Call initiated successfully! The AI agent is calling the lead.');
        } catch (error: any) {
            console.error('Error triggering call:', error);
            alert(error.message || 'Failed to trigger call');
        } finally {
            setCalling(false);
        }
    };

    return (
        <Button
            size="sm"
            variant="outline"
            onClick={handleCall}
            disabled={calling}
            className={`
                flex items-center gap-2 
                ${calling ? 'bg-orange-50 text-orange-600 border-orange-200' : 'text-brand-600 border-brand-200 hover:bg-brand-50'}
            `}
        >
            {calling ? (
                <>
                    <PhoneCall className="w-3.5 h-3.5 animate-pulse" />
                    Calling...
                </>
            ) : (
                <>
                    <Phone className="w-3.5 h-3.5" />
                    Call
                </>
            )}
        </Button>
    );
}
