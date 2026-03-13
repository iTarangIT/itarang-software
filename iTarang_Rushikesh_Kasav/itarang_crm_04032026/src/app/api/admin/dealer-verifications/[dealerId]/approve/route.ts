import { NextResponse } from 'next/server';

export async function POST(
  _req: Request,
  { params }: { params: { dealerId: string } }
) {
  try {
    // Replace with real DB update:
    // onboarding_status = 'succeed'
    // dealer_status = 'active'
    // finance_enablement = 'active'
    // generate credentials / email

    return NextResponse.json({
      success: true,
      message: `Dealer ${params.dealerId} approved successfully`,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, message: 'Approval failed' },
      { status: 500 }
    );
  }
}