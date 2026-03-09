import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { createDeviceMapping } from '@/lib/telemetry/queries';
import { v4 as uuidv4 } from 'uuid';

export async function POST(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const { mappings } = await req.json();

        if (!Array.isArray(mappings) || mappings.length === 0) {
            return NextResponse.json({ success: false, error: { message: 'No mappings provided' } }, { status: 400 });
        }

        let created = 0;
        let failed = 0;

        for (const m of mappings) {
            try {
                const id = `DBM-${uuidv4().slice(0, 8)}`;
                await createDeviceMapping({ id, ...m });
                created++;
            } catch {
                failed++;
            }
        }

        return NextResponse.json({ success: true, data: { created, failed, total: mappings.length } });
    } catch (error) {
        console.error('[Bulk Device Mapping] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
