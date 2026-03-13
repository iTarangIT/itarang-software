import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // Replace this with your real DB query
    const data = [
      {
        dealerId: 'DLR-001',
        dealerName: 'ABC Motors',
        companyName: 'ABC Motors Pvt Ltd',
        companyType: 'Pvt Ltd',
        documentsUploaded: 6,
        totalDocuments: 6,
        agreementStatus: 'Signed',
        onboardingStatus: 'pending_admin_review',
      },
      {
        dealerId: 'DLR-002',
        dealerName: 'Green EV',
        companyName: 'Green EV Partnership',
        companyType: 'Partnership',
        documentsUploaded: 5,
        totalDocuments: 6,
        agreementStatus: 'N/A',
        onboardingStatus: 'under_correction',
      },
    ];

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, message: 'Failed to load dealer verification queue' },
      { status: 500 }
    );
  }
}