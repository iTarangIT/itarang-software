import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { db } from '@/lib/db';
import { leads, dealerLeads } from '@/lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { runLeadQualification } from '@/lib/ai/langgraph/lead-qualification-graph';
import { getAICallerEnabled } from '@/lib/ai/settings';

const ALLOWED_PROVIDERS = ['bolna', 'elevenlabs'] as const;
type Provider = typeof ALLOWED_PROVIDERS[number];

export async function POST(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const body = await req.json();
        const { leadIds, provider: rawProvider } = body;

        if (!Array.isArray(leadIds) || leadIds.length === 0) {
            return NextResponse.json({ success: false, error: { message: 'leadIds array required' } }, { status: 400 });
        }

        const provider: Provider = ALLOWED_PROVIDERS.includes(rawProvider)
            ? rawProvider
            : 'bolna';

        const aiEnabled = await getAICallerEnabled();
        if (!aiEnabled) {
            return NextResponse.json(
                { success: false, error: { message: 'AI caller is currently disabled. Enable it from the AI Dialer settings.' } },
                { status: 403 }
            );
        }

        const aiOwner = provider === 'elevenlabs' ? 'elevenlabs_agent' : 'bolna_agent';
        const now = new Date();

        for (const leadId of leadIds) {
            await db.update(leads).set({
                ai_managed: true,
                ai_owner: aiOwner,
                manual_takeover: false,
                last_ai_action_at: now,
                updated_at: now,
            }).where(eq(leads.id, leadId));
        }

        // Mirror provider choice onto matching dealer_leads rows so the
        // call-scheduler crons route to the correct provider.
        const assignedLeads = await db
            .select({ phone: leads.phone })
            .from(leads)
            .where(inArray(leads.id, leadIds));

        const phones = assignedLeads
            .map((l) => l.phone)
            .filter((p): p is string => !!p);

        if (phones.length > 0) {
            await db
                .update(dealerLeads)
                .set({ provider })
                .where(inArray(dealerLeads.phone, phones));
        }

        const results = [];
        for (const leadId of leadIds.slice(0, 10)) {
            try {
                const result = await runLeadQualification(leadId);
                results.push({ ...result, leadId });
            } catch (err) {
                results.push({ leadId, error: err instanceof Error ? err.message : 'Scoring failed' });
            }
        }

        return NextResponse.json({
            success: true,
            assigned: leadIds.length,
            scored: results.length,
            provider,
            results,
        });
    } catch (error) {
        console.error('[AI Dialer Assign] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
