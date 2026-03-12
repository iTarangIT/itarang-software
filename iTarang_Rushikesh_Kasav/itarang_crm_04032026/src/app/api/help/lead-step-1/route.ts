import { successResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async () => {
    await requireRole(['dealer', 'ceo']);

    const content = {
        title: "Lead Creation: Step 1 of 5",
        sections: [
            {
                subtitle: "Getting Started",
                content: "Enter the customer's primary contact details. All red-asterisk fields are mandatory. Name must be capitalized and free of special characters."
            },
            {
                subtitle: "Aadhaar Auto-fill",
                content: "Upload clear PNG/JPEG/PDF images (Max 5MB). AI will extract Name, DOB, and Address. Always verify the extracted data before proceeding."
            },
            {
                subtitle: "Loan Compliance",
                content: "Father/Husband name is critical for loan eligibility. For vehicle leads, registration number (RC) triggers mandatory ownership fields."
            },
            {
                subtitle: "Lead Classification",
                content: "Hot leads (90) auto-navigate to Step 2 for immediate processing. Warm (60) and Cold (30) leads save progress and return to dashboard."
            }
        ]
    };

    return successResponse(content);
});
