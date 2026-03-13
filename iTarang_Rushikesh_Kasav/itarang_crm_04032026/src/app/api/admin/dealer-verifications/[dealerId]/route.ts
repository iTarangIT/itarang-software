import { NextResponse } from 'next/server';

export async function GET(
  _req: Request,
  { params }: { params: { dealerId: string } }
) {
  try {
    const data = {
      dealerId: params.dealerId,
      companyName: 'ABC Motors Pvt Ltd',
      companyAddress: 'Bangalore, Karnataka',
      gstNumber: '29ABCDE1234F1Z5',
      panNumber: 'ABCDE1234F',
      companyType: 'private_limited_firm',
      bankName: 'HDFC Bank',
      accountNumber: '123456789012',
      beneficiaryName: 'ABC Motors Pvt Ltd',
      ifscCode: 'HDFC0001234',
      financeEnabled: true,
      documents: [
        { name: 'GST Certificate', url: '#' },
        { name: 'PAN', url: '#' },
        { name: 'ITR', url: '#' },
        { name: 'Bank Statement', url: '#' },
      ],
      agreement: {
        agreementId: 'AGR-1001',
        signerName: 'Rahul Sharma',
        signerEmail: 'dealer@itarang.com',
        status: 'Signed',
        copyUrl: '#',
      },
    };

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      { success: false, message: 'Failed to load dealer details' },
      { status: 500 }
    );
  }
}