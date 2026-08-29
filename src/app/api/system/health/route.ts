import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth-utils';
import { withErrorHandler } from '@/lib/api-utils';

export const dynamic = 'force-dynamic';

/**
 * Env/connectivity diagnostic. Staff-only.
 *
 * This route used to be unauthenticated and returned DB_HOST, DB_PORT,
 * DB_USER, DB_NAME and DB_PASSWORD_LENGTH — i.e. it handed an anonymous caller
 * everything but the password itself, plus a live row count of `users`. Those
 * fields are gone; what remains is enough to answer "is this box configured and
 * can it reach the database?" without describing the database to a stranger.
 *
 * Two other things changed for the same reason the Ops Console exists:
 *  · it no longer opens its own postgres() client per request. RDS has ~79
 *    max_connections and no pooler, which is why src/lib/db caps at max: 5 —
 *    an unauthenticated endpoint that could be looped to open connections was
 *    a free denial of service.
 *  · errors are reported as a code, not a raw driver message.
 *
 * For unauthenticated liveness use /api/health, which is the deploy gate and
 * deliberately returns no configuration detail.
 */
export const GET = withErrorHandler(async () => {
    await requireRole(['ceo', 'admin']);

    const checks: Record<string, unknown> = {};

    checks.DATABASE_URL_SET = !!process.env.DATABASE_URL;
    checks.SUPABASE_URL_SET = !!process.env.NEXT_PUBLIC_SUPABASE_URL;
    checks.SUPABASE_ANON_KEY_SET = !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    checks.SERVICE_ROLE_KEY_SET = !!process.env.SUPABASE_SERVICE_ROLE_KEY;

    try {
        await db.execute(sql`SELECT 1`);
        checks.DB_CONNECTION = 'OK';
    } catch (e: unknown) {
        checks.DB_CONNECTION = 'FAILED';
        checks.DB_ERROR_CODE = (e as { code?: string })?.code ?? 'UNKNOWN';
    }

    return NextResponse.json(checks);
});
