// Server → client row mapping for EcofyLeadTable (E-307). A plain module (no
// "use client") so server pages can call it.

import type { EcofyLeadTableRow } from "./EcofyLeadTable";

/** Server → client row mapping (dates as ISO strings). */
export function toTableRow(l: {
    id: string;
    case_no: string | null;
    customer_name: string | null;
    customer_mobile: string | null;
    city: string | null;
    product_interest: string | null;
    segment: string | null;
    temperature: string | null;
    stage: string | null;
    sub_status: string | null;
    queue_entered_at: Date | null;
    assigned_to_user_id: string | null;
    assignee_name?: string | null;
    assigned_role: string | null;
    next_follow_up_at: Date | null;
    next_appointment_at: Date | null;
}): EcofyLeadTableRow {
    return {
        id: l.id,
        caseNo: l.case_no,
        customerName: l.customer_name,
        customerMobile: l.customer_mobile,
        city: l.city,
        productInterest: l.product_interest,
        segment: l.segment,
        temperature: l.temperature,
        stage: l.stage,
        subStatus: l.sub_status,
        queueEnteredAt: l.queue_entered_at?.toISOString() ?? null,
        assignedTo: l.assigned_to_user_id,
        assigneeName: l.assignee_name ?? null,
        assignedRole: l.assigned_role,
        nextFollowUpAt: l.next_follow_up_at?.toISOString() ?? null,
        nextAppointmentAt: l.next_appointment_at?.toISOString() ?? null,
    };
}
