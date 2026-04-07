import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import { loanFiles } from '@/lib/db/schema';
import { eq, and, or, ilike, gt, sql } from 'drizzle-orm';
import { resolveDealerProfile } from '@/lib/supabase/identity';

export async function GET(req: NextRequest) {
    try {
        const supabase = await createClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

        const profile = await resolveDealerProfile(supabase, user, 'id,email,role,dealer_id');
        if (!profile) {
            return NextResponse.json({ success: false, error: 'Access denied' }, { status: 403 });
        }

        const { searchParams } = new URL(req.url);
        const filter = searchParams.get('filter') || 'all';
        const search = searchParams.get('search') || '';

        const conditions = [eq(loanFiles.dealer_id, profile.dealer_id)];

        if (filter === 'active') conditions.push(eq(loanFiles.loan_status, 'active'));
        else if (filter === 'disbursed') conditions.push(eq(loanFiles.disbursal_status, 'disbursed'));
        else if (filter === 'overdue') conditions.push(gt(loanFiles.overdue_days, 0));
        else if (filter === 'closed') conditions.push(eq(loanFiles.loan_status, 'closed'));

        if (search) {
            conditions.push(
                or(
                    ilike(loanFiles.borrower_name, `%${search}%`),
                    ilike(loanFiles.co_borrower_name, `%${search}%`)
                )!
            );
        }

        const loans = await db
            .select()
            .from(loanFiles)
            .where(and(...conditions))
            .orderBy(sql`${loanFiles.created_at} DESC`);

        return NextResponse.json({ success: true, data: loans });
    } catch (error) {
        console.error('Loan fetch error:', error);
        return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
    }
}
