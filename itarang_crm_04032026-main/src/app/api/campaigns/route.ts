import { db } from '@/lib/db';
import { campaigns } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

function makeCampaignId() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const rand = Math.floor(Math.random() * 900 + 100); // 3 digits
    return `CAMP-${y}${m}${day}-${rand}`;
}

export const GET = withErrorHandler(async () => {
    const user = await requireRole(['dealer']);
    const rows = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.created_by, user.id))
        .limit(50);
    return successResponse(rows);
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['dealer']);
    const body = await req.json().catch(() => ({}));

    const name = String(body?.name || '').trim();
    const type = String(body?.type || '').trim();
    const message_content = String(body?.message_content || '').trim();
    const audience_filter = body?.audience_filter ?? null;
    const total_audience = Number.isFinite(body?.total_audience) ? Number(body.total_audience) : null;

    if (!name) return errorResponse('Campaign name is required', 400);
    if (!['sms', 'whatsapp', 'email'].includes(type)) return errorResponse('Invalid campaign type', 400);
    if (!message_content) return errorResponse('Message content is required', 400);

    const id = makeCampaignId();

    await db.insert(campaigns).values({
        id,
        name,
        type,
        status: 'draft',
        message_content,
        audience_filter,
        total_audience,
        created_by: user.id,
        created_at: new Date(),
    } as any);

    return successResponse({ id });
});