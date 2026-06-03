const BOLNA_API_KEY = process.env.BOLNA_API_KEY || '';
const BOLNA_AGENT_ID = process.env.BOLNA_AGENT_ID || '';
const BOLNA_BASE_URL = process.env.BOLNA_BASE_URL || 'https://api.bolna.ai';

interface BolnaCallParams {
    phoneNumber: string;
    leadName: string;
    leadContext: string;
    callbackUrl?: string;
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
        // Bolna identifies a placed call by its EXECUTION id (what POST /call
        // returns as `execution_id`, which we store as bolna_call_id). The
        // status/detail endpoint is `/executions/{id}` — `/call/{id}` 404s for
        // an execution id, which silently broke the dialer-poll backstop: every
        // poll got a 404, so a call whose webhook was dropped (all localhost
        // calls, and any dropped prod webhook) was never reconciled and the
        // watchdog wrongly marked the succeeded call `no_webhook`/failed.
        const res = await fetch(`${BOLNA_BASE_URL}/executions/${callId}`, {
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
