const BOLNA_API_KEY = process.env.BOLNA_API_KEY || '';
const BOLNA_AGENT_ID = process.env.BOLNA_AGENT_ID || '';
const BOLNA_BASE_URL = process.env.BOLNA_BASE_URL || 'https://api.bolna.ai';

interface BolnaCallParams {
    phoneNumber: string;
    leadName: string;
    leadContext: string;
    callbackUrl?: string;
    // Enriched context for better AI conversations
    leadId?: string;
    businessName?: string;
    city?: string;
    state?: string;
    source?: string;
    priorSummary?: string;
    intentScore?: number;
    assignedManager?: string;
}

interface BolnaCallResponse {
    success: boolean;
    callId?: string;
    message?: string;
    error?: string;
}

export async function triggerCall(params: BolnaCallParams): Promise<BolnaCallResponse> {
    if (!BOLNA_API_KEY || !BOLNA_AGENT_ID) {
        return { success: false, error: 'BOLNA_API_KEY and BOLNA_AGENT_ID must be set' };
    }

    try {
        const res = await fetch(`${BOLNA_BASE_URL}/call`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${BOLNA_API_KEY}`,
            },
            body: JSON.stringify({
                agent_id: BOLNA_AGENT_ID,
                recipient_phone_number: params.phoneNumber,
                user_data: {
                    lead_name: params.leadName,
                    context: params.leadContext,
                    ...(params.leadId && { lead_id: params.leadId }),
                    ...(params.businessName && { business_name: params.businessName }),
                    ...(params.city && { city: params.city }),
                    ...(params.state && { state: params.state }),
                    ...(params.source && { source: params.source }),
                    ...(params.priorSummary && { prior_summary: params.priorSummary }),
                    ...(params.intentScore !== undefined && { intent_score: params.intentScore }),
                    ...(params.assignedManager && { assigned_manager: params.assignedManager }),
                },
                metadata: {
                    lead_id: params.leadId || '',
                },
                ...(params.callbackUrl ? { callback_url: params.callbackUrl } : {}),
            }),
        });

        const data = await res.json();

        if (!res.ok) {
            return { success: false, error: data.message || `Bolna API error: ${res.status}` };
        }

        return {
            success: true,
            callId: data.call_id || data.id,
            message: data.message || 'Call initiated',
        };
    } catch (error) {
        console.error('[Bolna] Call trigger error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function getCallStatus(callId: string) {
    if (!BOLNA_API_KEY) {
        return { success: false, error: 'BOLNA_API_KEY not set' };
    }

    try {
        const res = await fetch(`${BOLNA_BASE_URL}/call/${callId}`, {
            headers: {
                'Authorization': `Bearer ${BOLNA_API_KEY}`,
            },
        });

        if (!res.ok) {
            return { success: false, error: `Status check failed: ${res.status}` };
        }

        const data = await res.json();
        return { success: true, ...data };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}
