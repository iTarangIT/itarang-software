import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import { serviceTickets, users } from '@/lib/db/schema';
import { eq, and, or, ilike, sql } from 'drizzle-orm';
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
        const status = searchParams.get('status') || 'all';
        const priority = searchParams.get('priority') || 'all';
        const search = searchParams.get('search') || '';

        const conditions = [eq(serviceTickets.dealer_id, profile.dealer_id)];

        if (status !== 'all') conditions.push(eq(serviceTickets.status, status));
        if (priority !== 'all') conditions.push(eq(serviceTickets.priority, priority));

        if (search) {
            conditions.push(
                or(
                    ilike(serviceTickets.customer_name, `%${search}%`),
                    ilike(serviceTickets.customer_phone, `%${search}%`),
                    ilike(serviceTickets.issue_description, `%${search}%`)
                )!
            );
        }

        const tickets = await db
            .select({
                id: serviceTickets.id,
                customer_name: serviceTickets.customer_name,
                customer_phone: serviceTickets.customer_phone,
                deployed_asset_id: serviceTickets.deployed_asset_id,
                issue_type: serviceTickets.issue_type,
                issue_description: serviceTickets.issue_description,
                priority: serviceTickets.priority,
                status: serviceTickets.status,
                assigned_to_name: users.name,
                resolution_type: serviceTickets.resolution_type,
                resolution_notes: serviceTickets.resolution_notes,
                sla_deadline: serviceTickets.sla_deadline,
                sla_breached: serviceTickets.sla_breached,
                created_at: serviceTickets.created_at,
            })
            .from(serviceTickets)
            .leftJoin(users, eq(serviceTickets.assigned_to, users.id))
            .where(and(...conditions))
            .orderBy(sql`${serviceTickets.created_at} DESC`);

        return NextResponse.json({ success: true, data: tickets });
    } catch (error) {
        console.error('Service tickets fetch error:', error);
        return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const supabase = await createClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

        const profile = await resolveDealerProfile(supabase, user, 'id,email,role,dealer_id');
        if (!profile) {
            return NextResponse.json({ success: false, error: 'Access denied' }, { status: 403 });
        }

        const body = await req.json();
        const { customer_name, customer_phone, deployed_asset_id, issue_type, issue_description, priority } = body;

        if (!customer_name || !issue_type || !issue_description) {
            return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
        }

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        const ticketId = `SVC-${dateStr}-${seq}`;

        // SLA deadline: critical=4h, high=8h, medium=24h, low=48h
        const slaHours: Record<string, number> = { critical: 4, high: 8, medium: 24, low: 48 };
        const slaDeadline = new Date(now.getTime() + (slaHours[priority] || 24) * 60 * 60 * 1000);

        await db.insert(serviceTickets).values({
            id: ticketId,
            dealer_id: profile.dealer_id,
            customer_name,
            customer_phone: customer_phone || null,
            deployed_asset_id: deployed_asset_id || null,
            issue_type,
            issue_description,
            priority: priority || 'medium',
            status: 'open',
            sla_deadline: slaDeadline,
            sla_breached: false,
            created_by: user.id,
            created_at: now,
            updated_at: now,
        });

        return NextResponse.json({ success: true, data: { id: ticketId } });
    } catch (error) {
        console.error('Service ticket creation error:', error);
        return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
    }
}
