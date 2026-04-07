
import { db } from '@/lib/db';
import { leads, leadAssignments, users, assignmentChangeLogs, callRecords, conversationMessages } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { requireAuth } from '@/lib/auth-utils';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import LeadAssignment from '@/components/leads/LeadAssignment';
import ConversationHistory from '@/components/leads/ConversationHistory';
import { ArrowLeft, History as HistoryIcon } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id: leadId } = await params;
    const user = await requireAuth();

    // 1. Fetch Lead
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) return <div className="p-8 text-center bg-white rounded-xl shadow-sm border m-8">Lead not found</div>;

    // 2. Fetch Assignment
    const [assignment] = await db.select().from(leadAssignments).where(eq(leadAssignments.lead_id, leadId)).limit(1);

    // 3. Fetch Call Records + Messages
    const rawRecords = await db.select()
        .from(callRecords)
        .where(eq(callRecords.lead_id, leadId))
        .orderBy(desc(callRecords.created_at));

    const recordsWithMessages = await Promise.all(rawRecords.map(async (record) => {
        const messages = await db.select()
            .from(conversationMessages)
            .where(eq(conversationMessages.call_record_id, record.id))
            .orderBy(conversationMessages.timestamp);

        return {
            ...record,
            messages: messages.map(m => ({
                id: m.id,
                role: m.role as 'user' | 'assistant',
                message: m.message || '',
                timestamp: m.timestamp?.toISOString() || new Date().toISOString()
            }))
        };
    }));

    // 4. Fetch All Users for Dropdown
    const allUsers = await db.select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role
    }).from(users);

    const isSalesHead = ['sales_head', 'business_head', 'ceo'].includes(user.role);
    const isOwner = assignment?.lead_owner === user.id;

    const canAssignOwner = isSalesHead;
    const canAssignActor = isSalesHead || isOwner;

    // 5. Fetch History
    const changedByUser = alias(users, 'changed_by_user');
    const oldUser = alias(users, 'old_user');
    const newUser = alias(users, 'new_user');

    const assignmentHistory = await db.select({
        id: assignmentChangeLogs.id,
        change_type: assignmentChangeLogs.change_type,
        change_reason: assignmentChangeLogs.change_reason,
        changed_at: assignmentChangeLogs.changed_at,
        changedByName: changedByUser.name,
        oldUserName: oldUser.name,
        newUserName: newUser.name,
    })
        .from(assignmentChangeLogs)
        .leftJoin(changedByUser, eq(assignmentChangeLogs.changed_by, changedByUser.id))
        .leftJoin(oldUser, eq(assignmentChangeLogs.old_user_id, oldUser.id))
        .leftJoin(newUser, eq(assignmentChangeLogs.new_user_id, newUser.id))
        .where(eq(assignmentChangeLogs.lead_id, leadId))
        .orderBy(desc(assignmentChangeLogs.changed_at));

    return (
        <div className="max-w-4xl mx-auto py-8 px-4">
            <Link href="/leads">
                <Button variant="ghost" className="mb-4 pl-0 hover:bg-transparent hover:text-brand-600 group">
                    <ArrowLeft className="w-4 h-4 mr-2 transition-transform group-hover:-translate-x-1" /> Back to Leads
                </Button>
            </Link>

            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
                {/* Header Section */}
                <div className="flex flex-col md:flex-row justify-between items-start mb-8 border-b pb-6 gap-4">
                    <div>
                        <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight">{lead.business_name || 'Unnamed Business'}</h1>
                        <p className="text-gray-500 font-medium mt-1">Lead ID: <span className="text-gray-900 font-mono">{lead.id}</span></p>
                    </div>
                    <div className="flex flex-col items-end">
                        <span className={`px-4 py-1.5 rounded-full text-xs font-bold tracking-wider uppercase
                            ${lead.interest_level === 'hot' ? 'bg-red-50 text-red-600 border border-red-100' :
                                lead.interest_level === 'warm' ? 'bg-orange-50 text-orange-600 border border-orange-100' :
                                    'bg-blue-50 text-blue-600 border border-blue-100'}`}>
                            {lead.interest_level} Interest
                        </span>
                        <div className="mt-3 text-xs font-bold text-gray-400 uppercase tracking-widest">
                            Status: <span className="text-gray-900">{lead.lead_status}</span>
                        </div>
                    </div>
                </div>

                {/* Details Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                    <div className="bg-slate-50/50 p-5 rounded-xl border border-gray-100">
                        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Contact Details</h3>
                        <div className="space-y-3 text-sm">
                            <div className="flex justify-between">
                                <span className="text-gray-500">Contact Name</span>
                                <span className="font-semibold text-gray-900">{lead.owner_name}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-500">Phone Number</span>
                                <span className="font-semibold text-gray-900 font-mono">{lead.owner_contact}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-500">Email Address</span>
                                <span className="font-semibold text-gray-900">{lead.owner_email || 'N/A'}</span>
                            </div>
                        </div>
                    </div>
                    <div className="bg-slate-50/50 p-5 rounded-xl border border-gray-100">
                        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Location & Business</h3>
                        <div className="space-y-3 text-sm">
                            <div className="flex justify-between">
                                <span className="text-gray-500">Region</span>
                                <span className="font-semibold text-gray-900">{lead.city}, {lead.state}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-500">Full Address</span>
                                <span className="font-semibold text-gray-900 truncate max-w-[180px]" title={lead.shop_address || ''}>{lead.shop_address || 'N/A'}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-500">Referral Source</span>
                                <span className="font-semibold text-gray-900 capitalize">{lead.lead_source?.replace('_', ' ')}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="space-y-8">
                    {/* Assignment Controls */}
                    <LeadAssignment
                        leadId={lead.id}
                        currentOwnerId={assignment?.lead_owner}
                        currentActorId={assignment?.lead_actor || undefined}
                        users={allUsers}
                        canAssignOwner={canAssignOwner}
                        canAssignActor={canAssignActor}
                    />

                    {/* AI Conversations */}
                    <ConversationHistory
                        records={recordsWithMessages.map(r => ({
                            ...r,
                            created_at: r.created_at?.toISOString() || new Date().toISOString()
                        }))}
                    />

                    {/* Timeline History */}
                    <div className="bg-slate-50/30 rounded-xl p-6 border border-gray-100">
                        <h3 className="text-lg font-bold text-gray-900 mb-6 flex items-center">
                            <span className="bg-brand-100 text-brand-600 p-1.5 rounded-lg mr-3">
                                <HistoryIcon size={18} />
                            </span>
                            Lead Lifecycle History
                        </h3>

                        <div className="space-y-5">
                            {assignmentHistory.length > 0 ? (
                                assignmentHistory.map((log) => (
                                    <div key={log.id} className="flex gap-4 group">
                                        <div className="flex flex-col items-center">
                                            <div className="w-2.5 h-2.5 rounded-full border-2 border-brand-500 bg-white z-10" />
                                            <div className="w-px flex-1 bg-gray-200 my-1 group-last:hidden" />
                                        </div>
                                        <div className="pb-6">
                                            <p className="text-sm text-gray-900">
                                                <span className="font-bold">{log.changedByName}</span>
                                                {' '}{log.change_type.replace(/_/g, ' ')}
                                                {log.newUserName && <span> to <span className="font-bold text-brand-600">{log.newUserName}</span></span>}
                                            </p>
                                            <p className="text-[11px] text-gray-400 font-bold uppercase tracking-wider mt-1.5">
                                                {new Date(log.changed_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                                                {log.change_reason && <span className="normal-case font-medium text-gray-500 ml-2 italic"> • "{log.change_reason}"</span>}
                                            </p>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="text-center py-6">
                                    <p className="text-gray-400 italic text-sm">No lifecycle history available.</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
