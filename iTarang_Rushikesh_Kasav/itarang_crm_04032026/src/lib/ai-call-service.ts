
import { createAdminClient } from './supabase/admin';
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { v4 as uuidv4 } from 'uuid';

const supabase = createAdminClient();

/**
 * Starts a new AI call session for a lead.
 */
export async function startCallSession(leadId: string) {
    console.log(`Starting call session for lead: ${leadId}`);

    const { data: lead, error: leadError } = await supabase
        .from('leads')
        .select('id, do_not_call, total_ai_calls')
        .eq('id', leadId)
        .single();

    if (leadError || !lead) throw new Error('Lead not found');
    if (lead.do_not_call) throw new Error('DNC enabled');

    const sessionId = uuidv4();

    const { error: sessionError } = await supabase
        .from('call_sessions')
        .insert({
            session_id: sessionId,
            status: 'active',
            created_at: new Date().toISOString(),
        });

    if (sessionError) throw sessionError;

    const { error: updateError } = await supabase
        .from('leads')
        .update({
            total_ai_calls: (lead.total_ai_calls || 0) + 1,
            last_ai_call_at: new Date().toISOString(),
        })
        .eq('id', leadId);

    if (updateError) throw updateError;

    return sessionId;
}

/**
 * Stores a single message from the conversation.
 */
export async function storeConversationMessage(callRecordId: string, role: 'user' | 'assistant', message: string) {
    const { error } = await supabase
        .from('conversation_messages')
        .insert({
            call_record_id: callRecordId,
            role,
            message,
            timestamp: new Date().toISOString(),
        });

    if (error) throw error;
}

/**
 * Ends a call session, performs AI analysis.
 */
export async function endCallSession(callRecordId: string, transcript: string) {
    // Analysis logic...
    let analysis;
    try {
        const model = new ChatOpenAI({
            openAIApiKey: process.env.OPENAI_API_KEY,
            modelName: "gpt-4o-mini",
            temperature: 0,
        });

        const analysisPrompt = PromptTemplate.fromTemplate(`
            Analyze the following transcript.
            Return ONLY a JSON object with:
            - summary: A brief summary.
            - sentiment_score: 0 to 1.
            - qualification_score: 0 to 100.

            Transcript:
            {transcript}
        `);

        const chain = analysisPrompt.pipe(model).pipe(new StringOutputParser());
        const resultText = await chain.invoke({ transcript });

        const jsonStr = resultText.replace(/```json|```/g, '').trim();
        analysis = JSON.parse(jsonStr);
    } catch (err) {
        analysis = { summary: "Analysis failed", sentiment_score: 0.5, qualification_score: 0 };
    }

    const { error } = await supabase
        .from('call_records')
        .update({
            status: 'completed',
            summary: analysis.summary,
            transcript,
            ended_at: new Date().toISOString(),
        })
        .eq('id', callRecordId);

    if (error) throw error;

    return analysis;
}

export async function storeCallRecording(callRecordId: string, recordingUrl: string, duration: number) {
    const { error } = await supabase
        .from('call_records')
        .update({
            recording_url: recordingUrl,
            duration_seconds: duration,
        })
        .eq('id', callRecordId);

    if (error) throw error;
}
