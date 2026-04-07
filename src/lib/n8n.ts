const N8N_BASE_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.srv1128060.hstgr.cloud';

export type WebhookType =
    | 'product-catalog-created'
    | 'oem-onboarded'
    | 'provision-created'
    | 'pdi-needed'
    | 'pdi-completed'
    | 'order-created-request-pi'
    | 'pi-approval-workflow'
    | 'invoice-uploaded'
    | 'payment-made'
    | 'grn-created'
    | 'lead-assigned'
    | 'deal-approval-workflow'
    | 'deal-submitted'
    | 'invoice-issued'
    | 'order-disputed'
    | 'order-fulfilled'
    | 'sla-monitor'
    | 'sla-breach-notification'
    | 'sla-breach-detected'
    | 'system-critical-error'
    | 'daily-summary';

/**
 * Triggers an n8n webhook with a standardized payload and robust error handling.
 * This is the primary bridge between the CRM and automated workflows in n8n.
 */
export async function triggerN8nWebhook(webhook: WebhookType, data: any) {
    if (!N8N_BASE_URL) {
        console.warn('n8n: N8N_WEBHOOK_URL not configured, skipping trigger');
        return false;
    }

    try {
        const payload = {
            ...data,
            _metadata: {
                timestamp: new Date().toISOString(),
                environment: process.env.NODE_ENV,
                webhook_type: webhook,
            }
        };

        const response = await fetch(`${N8N_BASE_URL}/webhook/${webhook}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Source': 'itarang-crm-v4',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'No error body');
            console.error(`n8n: Webhook [${webhook}] failed with status ${response.status}: ${errorText}`);

            // In a real production app, we would log this to a monitoring service (e.g. Sentry/LogDNA)
            return false;
        }

        return true;
    } catch (error) {
        console.error(`n8n: Connection error triggering [${webhook}]:`, error);
        return false;
    }
}
