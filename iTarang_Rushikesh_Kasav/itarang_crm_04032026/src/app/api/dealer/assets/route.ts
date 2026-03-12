import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import { deployedAssets } from '@/lib/db/schema';
import { eq, and, or, ilike, sql } from 'drizzle-orm';

export async function GET(req: NextRequest) {
    try {
        const supabase = await createClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

        const { data: profile } = await supabase.from('users').select('role, dealer_id').eq('id', user.id).single();
        if (profile?.role !== 'dealer' || !profile?.dealer_id) {
            return NextResponse.json({ success: false, error: 'Access denied' }, { status: 403 });
        }

        const { searchParams } = new URL(req.url);
        const status = searchParams.get('status') || 'all';
        const payment = searchParams.get('payment') || 'all';
        const category = searchParams.get('category') || 'all';
        const search = searchParams.get('search') || '';

        const conditions = [eq(deployedAssets.dealer_id, profile.dealer_id)];

        if (status !== 'all') conditions.push(eq(deployedAssets.status, status));
        if (payment !== 'all') conditions.push(eq(deployedAssets.payment_type, payment));
        if (category !== 'all') conditions.push(eq(deployedAssets.asset_category, category));

        if (search) {
            conditions.push(
                or(
                    ilike(deployedAssets.serial_number, `%${search}%`),
                    ilike(deployedAssets.customer_name, `%${search}%`),
                    ilike(deployedAssets.customer_phone, `%${search}%`)
                )!
            );
        }

        const assets = await db
            .select()
            .from(deployedAssets)
            .where(and(...conditions))
            .orderBy(sql`${deployedAssets.deployment_date} DESC`);

        return NextResponse.json({ success: true, data: assets });
    } catch (error) {
        console.error('Assets fetch error:', error);
        return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
    }
}
