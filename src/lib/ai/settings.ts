import { db } from '@/lib/db';
import { appSettings } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function getAICallerEnabled(): Promise<boolean> {
    try {
        const [row] = await db
            .select()
            .from(appSettings)
            .where(eq(appSettings.key, 'ai_caller_enabled'))
            .limit(1);

        if (!row) return true; // Default to enabled if no setting exists
        const val = row.value as { enabled?: boolean };
        return val.enabled !== false;
    } catch (err) {
        console.error('[Settings] Failed to read ai_caller_enabled:', err);
        return true; // Default to enabled on error
    }
}

export async function setAICallerEnabled(enabled: boolean): Promise<void> {
    const now = new Date();
    await db
        .insert(appSettings)
        .values({
            key: 'ai_caller_enabled',
            value: { enabled },
            updated_at: now,
        })
        .onConflictDoUpdate({
            target: appSettings.key,
            set: {
                value: { enabled },
                updated_at: now,
            },
        });
}
