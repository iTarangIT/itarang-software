import { StateGraph, Annotation, END } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { db } from '@/lib/db';
import { leads, aiCallLogs } from '@/lib/db/schema';
import { eq, desc, and, gte } from 'drizzle-orm';
import { triggerCall } from '@/lib/ai/bolna-client';
import { getAICallerEnabled } from '@/lib/ai/settings';

// ─── State Definition ────────────────────────────────────────────────────────

const GraphState = Annotation.Root({
    leadId: Annotation<string>,
    lead: Annotation<Record<string, unknown> | null>({ reducer: (_, b) => b, default: () => null }),
    callLogs: Annotation<Record<string, unknown>[]>({ reducer: (_, b) => b, default: () => [] }),
    latestTranscript: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
    conversationSummary: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
    intentScore: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
    intentReason: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
    suggestedPitch: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
    objections: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
    nextAction: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
    callPriority: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
    nextCallAt: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
    shouldCall: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
    callResult: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
    error: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
});

type State = typeof GraphState.State;

const model = new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o',
    temperature: 0.3,
});

// ─── Node 1: Fetch Lead Context ──────────────────────────────────────────────

async function fetchLeadContext(state: State): Promise<Partial<State>> {
    try {
        // Check global AI caller toggle
        const aiEnabled = await getAICallerEnabled();
        if (!aiEnabled) {
            console.log(`[LangGraph] Skipping lead ${state.leadId}: AI caller globally disabled`);
            return { error: 'AI_CALLER_DISABLED' };
        }

        const [lead] = await db.select().from(leads).where(eq(leads.id, state.leadId)).limit(1);
        if (!lead) return { error: 'Lead not found' };

        // Check manual takeover
        if (lead.manual_takeover) {
            return { lead: lead as unknown as Record<string, unknown>, error: 'MANUAL_TAKEOVER' };
        }

        const callHistory = await db.select()
            .from(aiCallLogs)
            .where(eq(aiCallLogs.lead_id, state.leadId))
            .orderBy(desc(aiCallLogs.created_at))
            .limit(10);

        // Rate limit: max 3 calls per day
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayCalls = callHistory.filter(c => c.created_at && new Date(c.created_at) >= today);
        if (todayCalls.length >= 3) {
            return {
                lead: lead as unknown as Record<string, unknown>,
                callLogs: callHistory as unknown as Record<string, unknown>[],
                error: 'RATE_LIMIT_EXCEEDED',
            };
        }

        const latestTranscript = callHistory[0]?.transcript || '';

        return {
            lead: lead as unknown as Record<string, unknown>,
            callLogs: callHistory as unknown as Record<string, unknown>[],
            latestTranscript,
            conversationSummary: lead.conversation_summary || '',
        };
    } catch (err) {
        return { error: `fetchLeadContext failed: ${err instanceof Error ? err.message : 'unknown'}` };
    }
}

// ─── Node 2: Summarize Conversation ──────────────────────────────────────────

async function summarizeConversation(state: State): Promise<Partial<State>> {
    if (!state.latestTranscript && !state.conversationSummary) {
        return { conversationSummary: 'No conversation history yet.' };
    }

    try {
        const result = await model.invoke([
            {
                role: 'system',
                content: 'You are a sales conversation analyst. Create a concise rolling summary of the customer conversation. Include key points, customer sentiment, objections raised, and interest indicators. Keep under 200 words.',
            },
            {
                role: 'user',
                content: `Previous summary:\n${state.conversationSummary || 'None'}\n\nLatest transcript:\n${state.latestTranscript || 'No new transcript'}\n\nLead info: ${state.lead?.full_name || state.lead?.owner_name}, interested in: ${state.lead?.asset_model || 'unknown product'}`,
            },
        ]);

        return { conversationSummary: typeof result.content === 'string' ? result.content : String(result.content) };
    } catch {
        return {};
    }
}

// ─── Node 3: Score Purchase Intent ───────────────────────────────────────────

async function scorePurchaseIntent(state: State): Promise<Partial<State>> {
    try {
        const leadInfo = state.lead || {};
        const result = await model.invoke([
            {
                role: 'system',
                content: `You are a lead scoring expert for an EV/battery company. Score the lead's purchase intent from 0-100 based on all available data. Respond ONLY with valid JSON:
{
  "score": <number 0-100>,
  "reason": "<1-2 sentence rationale>",
  "objections": "<known objections or 'none'>",
  "suggested_pitch": "<1-2 sentence recommended approach>"
}`,
            },
            {
                role: 'user',
                content: `Lead: ${leadInfo.full_name || leadInfo.owner_name}
Interest level: ${leadInfo.interest_level || 'unknown'}
Lead status: ${leadInfo.lead_status || 'new'}
Product interest: ${leadInfo.asset_model || 'unknown'}
Investment capacity: ${leadInfo.investment_capacity || 'unknown'}
Business type: ${leadInfo.business_type || 'unknown'}
Total AI calls: ${leadInfo.total_ai_calls || 0}
Last call outcome: ${leadInfo.last_call_outcome || 'none'}
Conversation summary: ${state.conversationSummary || 'No conversation yet'}`,
            },
        ]);

        const text = typeof result.content === 'string' ? result.content : String(result.content);
        const jsonStr = text.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(jsonStr);

        return {
            intentScore: Number(parsed.score) || 0,
            intentReason: parsed.reason || '',
            objections: parsed.objections || '',
            suggestedPitch: parsed.suggested_pitch || '',
        };
    } catch {
        return { intentScore: 30, intentReason: 'Scoring failed, defaulting to low' };
    }
}

// ─── Node 4: Decide Next Action ──────────────────────────────────────────────

async function decideNextAction(state: State): Promise<Partial<State>> {
    const score = state.intentScore;
    const lead = state.lead || {};
    const now = new Date();

    // High intent (70+) → call now
    if (score >= 70) {
        return {
            nextAction: 'call_now',
            callPriority: score,
            shouldCall: true,
            nextCallAt: now.toISOString(),
        };
    }

    // Medium intent (40-69) → schedule for later today or tomorrow
    if (score >= 40) {
        const scheduleTime = new Date(now.getTime() + 4 * 60 * 60 * 1000); // 4 hours later
        return {
            nextAction: 'schedule_later',
            callPriority: score,
            shouldCall: false,
            nextCallAt: scheduleTime.toISOString(),
        };
    }

    // Low intent (< 40) → mark cold, schedule far out
    const coldSchedule = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days
    return {
        nextAction: 'mark_cold',
        callPriority: Math.max(score, 10),
        shouldCall: false,
        nextCallAt: coldSchedule.toISOString(),
    };
}

// ─── Node 5: Write Back to DB ────────────────────────────────────────────────

async function writeBackToDB(state: State): Promise<Partial<State>> {
    try {
        const intentBand = state.intentScore >= 70 ? 'high' : state.intentScore >= 40 ? 'medium' : 'low';

        await db.update(leads).set({
            intent_score: state.intentScore,
            intent_reason: state.intentReason,
            intent_band: intentBand,
            intent_scored_at: new Date(),
            intent_details: {
                score: state.intentScore,
                reason: state.intentReason,
                objections: state.objections,
                suggested_pitch: state.suggestedPitch,
            },
            conversation_summary: state.conversationSummary,
            call_priority: state.callPriority,
            next_call_at: state.nextCallAt ? new Date(state.nextCallAt) : null,
            last_ai_action_at: new Date(),
            updated_at: new Date(),
        }).where(eq(leads.id, state.leadId));

        return {};
    } catch (err) {
        return { error: `writeBackToDB failed: ${err instanceof Error ? err.message : 'unknown'}` };
    }
}

// ─── Node 6: Place Call with Bolna ───────────────────────────────────────────

async function placeCallWithBolna(state: State): Promise<Partial<State>> {
    if (!state.shouldCall) return { callResult: 'skipped' };

    const lead = state.lead || {};
    const phone = String(lead.phone || lead.owner_contact || lead.mobile || '');
    if (!phone) return { callResult: 'no_phone_number' };

    const callbackUrl = process.env.NEXT_PUBLIC_APP_URL
        ? `${process.env.NEXT_PUBLIC_APP_URL}/api/ceo/ai-dialer/webhook/bolna`
        : undefined;

    const result = await triggerCall({
        phoneNumber: phone,
        leadName: String(lead.full_name || lead.owner_name || 'Customer'),
        leadContext: `Intent score: ${state.intentScore}. ${state.suggestedPitch}. ${state.conversationSummary}`,
        callbackUrl,
        leadId: state.leadId,
        businessName: String(lead.business_name || ''),
        city: String(lead.city || ''),
        state: String(lead.state || ''),
        source: String(lead.lead_source || ''),
        priorSummary: state.conversationSummary,
        intentScore: state.intentScore,
    });

    if (result.success && result.callId) {
        // Log the call
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');

        await db.insert(aiCallLogs).values({
            id: `AICALL-${dateStr}-${seq}`,
            lead_id: state.leadId,
            call_id: result.callId,
            provider: 'bolna',
            status: 'initiated',
            started_at: now,
            model_used: 'gpt-4o',
            intent_score: state.intentScore,
            intent_reason: state.intentReason,
            next_action: state.nextAction,
            created_at: now,
        });

        // Update lead
        await db.update(leads).set({
            last_call_status: 'initiated',
            last_ai_call_at: now,
            total_ai_calls: (Number(lead.total_ai_calls) || 0) + 1,
            updated_at: now,
        }).where(eq(leads.id, state.leadId));
    }

    return { callResult: result.success ? `call_initiated:${result.callId}` : `failed:${result.error}` };
}

// ─── Routing Functions ───────────────────────────────────────────────────────

function shouldStop(state: State): string {
    if (state.error === 'AI_CALLER_DISABLED' || state.error === 'MANUAL_TAKEOVER' || state.error === 'RATE_LIMIT_EXCEEDED') return END;
    if (state.error && !state.error.startsWith('MANUAL') && !state.error.startsWith('RATE')) return END;
    return 'summarizeConversation';
}

function shouldPlaceCall(state: State): string {
    return state.shouldCall ? 'placeCallWithBolna' : END;
}

// ─── Build Graph ─────────────────────────────────────────────────────────────

function buildLeadQualificationGraph() {
    const graph = new StateGraph(GraphState)
        .addNode('fetchLeadContext', fetchLeadContext)
        .addNode('summarizeConversation', summarizeConversation)
        .addNode('scorePurchaseIntent', scorePurchaseIntent)
        .addNode('decideNextAction', decideNextAction)
        .addNode('writeBackToDB', writeBackToDB)
        .addNode('placeCallWithBolna', placeCallWithBolna)
        .addEdge('__start__', 'fetchLeadContext')
        .addConditionalEdges('fetchLeadContext', shouldStop)
        .addEdge('summarizeConversation', 'scorePurchaseIntent')
        .addEdge('scorePurchaseIntent', 'decideNextAction')
        .addEdge('decideNextAction', 'writeBackToDB')
        .addConditionalEdges('writeBackToDB', shouldPlaceCall)
        .addEdge('placeCallWithBolna', END);

    return graph.compile();
}

// ─── Exports ─────────────────────────────────────────────────────────────────

let _compiledGraph: ReturnType<typeof buildLeadQualificationGraph> | null = null;

function getGraph() {
    if (!_compiledGraph) {
        _compiledGraph = buildLeadQualificationGraph();
    }
    return _compiledGraph;
}

export async function runLeadQualification(leadId: string) {
    const graph = getGraph();
    const result = await graph.invoke({ leadId });
    return {
        leadId,
        intentScore: result.intentScore,
        intentReason: result.intentReason,
        nextAction: result.nextAction,
        callPriority: result.callPriority,
        nextCallAt: result.nextCallAt,
        shouldCall: result.shouldCall,
        callResult: result.callResult,
        error: result.error,
        conversationSummary: result.conversationSummary,
    };
}

export async function runPostCallUpdate(leadId: string, transcript: string, callId: string) {
    // Update call log with transcript
    if (callId) {
        await db.update(aiCallLogs).set({
            transcript,
            status: 'completed',
            ended_at: new Date(),
        }).where(eq(aiCallLogs.call_id, callId));
    }

    // Re-run qualification with new transcript context
    // First update lead with new transcript so graph picks it up
    await db.update(leads).set({
        last_call_status: 'completed',
        updated_at: new Date(),
    }).where(eq(leads.id, leadId));

    return runLeadQualification(leadId);
}
