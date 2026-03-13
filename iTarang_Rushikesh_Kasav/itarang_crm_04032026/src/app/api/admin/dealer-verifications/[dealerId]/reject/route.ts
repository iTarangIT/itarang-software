import { NextResponse } from 'next/server';

export async function POST(
  req: Request,
  { params }: { params: { dealerId: string } }
) {
  try {
    const body = await req.json();

    return NextResponse.json({
      success: true,
      message: `Dealer ${params.dealerId} rejected`,
      remarks: body.remarks,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, message: 'Rejection failed' },
      { status: 500 }
    );
  }
}