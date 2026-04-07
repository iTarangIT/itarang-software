import { db } from './db';
import { auditLogs, slas } from './db/schema';
import { generateId } from './api-utils';
import { eq } from 'drizzle-orm';
import { triggerN8nWebhook } from './n8n';

/**
 * Logs an SLA breach and triggers notifications.
 * SOP 2.4/19.2
 */
export async function logSlaBreach(slaId: string, details: string, performedBy?: string) {
    console.warn(`[SLA BREACH] SLA ID: ${slaId} - ${details}`);

    try {
        // Update SLA status in database
        await db.update(slas)
            .set({ status: 'breached' })
            .where(eq(slas.id, slaId));

        // Audit Log (If performedBy is provided, otherwise we'd need a system user UUID)
        if (performedBy) {
            await db.insert(auditLogs).values({
                id: await generateId('AUDIT', auditLogs),
                entity_type: 'sla',
                entity_id: slaId,
                action: 'breach_detected',
                changes: { details },
                performed_by: performedBy,
                timestamp: new Date(),
            });
        }

        // Trigger n8n notification for SLA breach
        await triggerN8nWebhook('sla-breach-detected', {
            sla_id: slaId,
            details,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Failed to log SLA breach:', error);
    }
}

/**
 * Capture critical system errors for monitoring.
 * In a real-world scenario, this would integrate with Sentry.
 */
export async function captureCriticalError(error: Error, context: any) {
    console.error(`[CRITICAL ERROR]`, {
        message: error.message,
        stack: error.stack,
        context
    });

    // Mock Sentry integration
    // if (process.env.SENTRY_DSN) {
    //     // Sentry.captureException(error, { extra: context });
    // }

    // Logic to alert dev team via n8n/slack
    await triggerN8nWebhook('system-critical-error', {
        error: error.message,
        context,
        timestamp: new Date().toISOString()
    });
}
