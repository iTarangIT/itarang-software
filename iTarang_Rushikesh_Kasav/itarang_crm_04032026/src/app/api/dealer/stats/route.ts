
import { createClient } from '@/lib/supabase/server';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';

export const GET = withErrorHandler(async (req: Request) => {
    const supabase = await createClient();

    // 1. Authenticate
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return errorResponse('Unauthorized', 401);

    const { data: profile } = await supabase.from('users').select('role, dealer_id').eq('id', user.id).single();
    if (profile?.role !== 'dealer' || !profile?.dealer_id) {
        return errorResponse('Access denied', 403);
    }

    // 2. Query KPIs (Parallel)
    // We fetch counts for Leads, Conversions, Inventory items, Orders, and Loans
    const [
        { count: totalLeads },
        { count: convertedLeads },
        { data: recentLeads },
        { count: inventoryCount },
        { data: orders },
        { count: loanCount }
    ] = await Promise.all([
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('dealer_id', profile.dealer_id),
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('dealer_id', profile.dealer_id).eq('lead_status', 'converted'),
        supabase.from('leads').select('*').eq('dealer_id', profile.dealer_id).order('created_at', { ascending: false }).limit(5),
        supabase.from('inventory').select('*', { count: 'exact', head: true }).eq('created_by', user.id), // Based on schema structure
        supabase.from('orders').select('total_amount').eq('account_id', profile.dealer_id),
        supabase.from('loan_applications').select('*', { count: 'exact', head: true }).eq('created_by', user.id)
    ]);

    const conversionRate = totalLeads ? Math.round((convertedLeads! / totalLeads!) * 100) : 0;

    // Sum total order amounts for "Payments" metric
    const totalPayments = orders?.reduce((sum, order) => sum + Number(order.total_amount || 0), 0) || 0;

    return successResponse({
        metrics: {
            totalLeads: totalLeads || 0,
            convertedLeads: convertedLeads || 0,
            conversionRate,
            commission: 0, // No logic for commission yet in schema
            inventoryCount: inventoryCount || 0,
            totalPayments,
            loanCount: loanCount || 0,
            rewards: 0 // Placeholder
        },
        recentLeads: recentLeads || []
    });
});
