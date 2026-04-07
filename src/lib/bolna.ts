
const BOLNA_API_KEY = process.env.BOLNA_API_KEY;
const BOLNA_AGENT_ID = process.env.BOLNA_AGENT_ID;
const BOLNA_BASE_URL = process.env.BOLNA_BASE_URL || 'https://api.bolna.ai';

export async function triggerBolnaCall(phoneNumber: string, leadId: string, leadDetails: any = {}) {
    if (!BOLNA_API_KEY || !BOLNA_AGENT_ID) {
        console.error('Bolna credentials not configured');
        return { success: false, error: 'Bolna credentials missing' };
    }

    try {
        const response = await fetch(`${BOLNA_BASE_URL}/call`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${BOLNA_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                agent_id: BOLNA_AGENT_ID,
                recipient_phone_number: phoneNumber,
                metadata: {
                    lead_id: leadId
                },
                user_data: {
                    owner_name: leadDetails.owner_name || '',
                    location: `${leadDetails.city || ''}, ${leadDetails.state || ''}`.trim().replace(/^, |,$/g, '') || '',
                    interest: leadDetails.interest_level || '',
                    status: leadDetails.lead_status || '',
                    lead_id: leadId
                }
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('Bolna API error:', data);
            return { success: false, error: data.message || 'Failed to trigger call' };
        }

        return { success: true, callId: data.call_id };
    } catch (error: any) {
        console.error('Bolna connection error:', error);
        return { success: false, error: error.message || 'Connection error' };
    }
}
