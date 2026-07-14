import { NextResponse } from 'next/server';
import { ZodError, z } from 'zod';
import crypto from 'crypto';
import { sanitizeDbError } from '@/lib/error-utils';

/**
 * Validates a stored file reference. Since the Supabase→S3 migration,
 * `uploadFileToStorage` returns an app-relative proxy path
 * (`/api/files/<bucket>/<key>`, see filesProxyPath) rather than an absolute
 * public URL. This accepts both: the new relative proxy paths AND any legacy
 * absolute http(s) URLs persisted before the migration. Plain `z.string().url()`
 * rejects the relative form and 400s the request.
 */
export const storedFileUrl = z
    .string()
    .min(1)
    .refine(
        (s) => s.startsWith('/') || /^https?:\/\//i.test(s),
        'Must be an absolute http(s) URL or an app-relative /api/files path',
    );

export function successResponse(data: any, status = 200) {
    return NextResponse.json({
        success: true,
        data,
        timestamp: new Date().toISOString()
    }, { status });
}

export function errorResponse(message: string, status = 500) {
    return NextResponse.json({
        success: false,
        error: { message },
        timestamp: new Date().toISOString()
    }, { status });
}

export function withErrorHandler(handler: Function) {
    return async (req: Request, context?: any) => {
        try {
            return await handler(req, context);
        } catch (error: any) {
            // Re-throw Next.js redirect errors
            if (error.digest?.startsWith('NEXT_REDIRECT')) {
                throw error;
            }

            console.error('API Error:', error);

            // Errors that carry their own HTTP status keep it (see
            // src/lib/buyback/errors.ts — HttpError and its subclasses). Without
            // this, a refused state transition or a role violation would surface
            // as a 500 and be indistinguishable from a server bug. Nothing else
            // in the repo sets `.status` on a thrown error, so this is inert for
            // every existing caller.
            if (typeof error?.status === 'number' && error.status >= 400 && error.status < 600) {
                // `details` lets an error carry structure alongside its sentence —
                // e.g. the buyback submit gate returns one issue per battery line
                // so the intake page can highlight the offending rows rather than
                // just printing a paragraph.
                return NextResponse.json({
                    success: false,
                    error: {
                        message: error.message || 'Request failed',
                        ...(error.details ? { details: error.details } : {}),
                    },
                    timestamp: new Date().toISOString(),
                }, { status: error.status });
            }

            if (error instanceof ZodError) {
                return NextResponse.json({
                    success: false,
                    error: {
                        message: 'Validation failed',
                        details: error.issues.map(i => ({
                            path: i.path.join('.'),
                            message: i.message
                        }))
                    },
                    timestamp: new Date().toISOString()
                }, { status: 400 });
            }
            return errorResponse(sanitizeDbError(error) || 'Internal error', 500);
        }
    };
}

/** True for Next.js redirect/notFound control-flow errors that must be re-thrown. */
export function isNextRedirectError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        typeof (error as { digest?: unknown }).digest === 'string' &&
        (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
    );
}

/** Safely extract a message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function generateId(prefix: string, _table?: any): Promise<string> {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    return `${prefix}-${date}-${rand}`;
}

