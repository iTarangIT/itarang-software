import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth-utils';
import { EditLeadForm } from '@/components/leads/edit-lead-form';

export const dynamic = 'force-dynamic';

export default async function EditLeadPage({ params }: { params: Promise<{ id: string }> }) {
    await requireAuth();
    const { id } = await params;
    console.log('[Edit Lead Page] Loading for ID:', id);

    const [lead] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);

    if (!lead) {
        return <div className="p-8">Lead not found</div>;
    }

    return (
        <div className="max-w-2xl mx-auto py-8 px-4">
            <h1 className="text-2xl font-bold mb-6 text-gray-900">Edit Lead</h1>
            <EditLeadForm initialData={lead} leadId={id} />
        </div>
    );
}
